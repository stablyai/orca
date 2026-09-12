import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-journal'
import type { PtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'
import {
  PtyOwnershipTransferDestinationOutputSink,
  type PtyOwnershipTransferDestinationOutputDelivery
} from './pty-ownership-transfer-destination-output-sink'

const identity: PtyOwnershipTransferIdentity = {
  bridgeId: 'bridge-1',
  terminalId: 'terminal-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-1'
}

const binding: PtyOwnershipTransferSurfaceBinding = {
  executionHostId: 'local',
  workspaceKey: 'folder:folder-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: identity.terminalId
}

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-transfer-output-sink-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function createSink(
  deliver: PtyOwnershipTransferDestinationOutputDelivery,
  outboxOptions: { maxBytes?: number; maxFrames?: number } = {}
) {
  return new PtyOwnershipTransferDestinationOutputSink({
    outbox: new PtyOwnershipTransferDestinationOutputOutbox({ directory, ...outboxOptions }),
    deliver
  })
}

describe('PtyOwnershipTransferDestinationOutputSink', () => {
  it('advances the durable outbox only after an exact destination acknowledgement', () => {
    const deliver = vi.fn((_identity, _binding, frame) => ({
      identity,
      throughSeq: frame.seq
    }))
    const sink = createSink(deliver)

    sink.open(identity, 0)
    expect(sink.publish(identity, binding, { seq: 1, data: 'first\n' })).toMatchObject({
      acknowledgedEndSeq: 1,
      pendingFrames: []
    })
    expect(deliver).toHaveBeenCalledWith(identity, binding, { seq: 1, data: 'first\n' })
  })

  it('stages output durably without invoking the destination delivery callback', () => {
    const deliver = vi.fn((_identity, _binding, frame) => ({
      identity,
      throughSeq: frame.seq
    }))
    const sink = createSink(deliver)

    sink.open(identity, 0)
    expect(sink.stage(identity, { seq: 1, data: 'pending' })).toMatchObject({
      acknowledgedEndSeq: 0,
      pendingFrames: [{ seq: 1, data: 'pending' }]
    })
    expect(deliver).not.toHaveBeenCalled()
    expect(sink.publish(identity, binding, { seq: 1, data: 'pending' })).toMatchObject({
      acknowledgedEndSeq: 1,
      pendingFrames: []
    })
    expect(deliver).toHaveBeenCalledOnce()
  })

  it('retains output when delivery fails and drains it after restart', () => {
    const failed = createSink(() => {
      throw new Error('surface_unavailable')
    })
    failed.open(identity, 0)
    expect(() => failed.publish(identity, binding, { seq: 1, data: 'pending' })).toThrow(
      'surface_unavailable'
    )

    const delivered: number[] = []
    const recovered = createSink((_identity, _binding, frame) => {
      delivered.push(frame.seq)
      return { identity, throughSeq: frame.seq }
    })
    expect(recovered.drain(identity, binding)).toMatchObject({
      acknowledgedEndSeq: 1,
      pendingFrames: []
    })
    expect(delivered).toEqual([1])
  })

  it('rejects mismatched acknowledgements without dropping pending output', () => {
    const sink = createSink(() => ({
      identity: { ...identity, ownerLease: 'wrong' },
      throughSeq: 1
    }))
    sink.open(identity, 0)
    expect(() => sink.publish(identity, binding, { seq: 1, data: 'first' })).toThrow(
      'pty_ownership_transfer_output_sink_ack_invalid'
    )
    const recovered = createSink((_identity, _binding, frame) => ({
      identity,
      throughSeq: frame.seq
    }))
    expect(recovered.drain(identity, binding)).toMatchObject({
      acknowledgedEndSeq: 1,
      pendingFrames: []
    })
  })

  it('rejects malformed acknowledgement identities without leaking a type error', () => {
    const sink = createSink(() => ({ identity: undefined, throughSeq: 1 }) as never)
    sink.open(identity, 0)
    expect(() => sink.publish(identity, binding, { seq: 1, data: 'first' })).toThrow(
      'pty_ownership_transfer_output_sink_ack_invalid'
    )
    const recovered = createSink((_identity, _binding, frame) => ({
      identity,
      throughSeq: frame.seq
    }))
    expect(recovered.drain(identity, binding)).toMatchObject({
      acknowledgedEndSeq: 1,
      pendingFrames: []
    })
  })

  it('does not redeliver frames covered by a cumulative drain acknowledgement', () => {
    const first = createSink((_identity, _binding, frame) => ({
      identity,
      throughSeq: frame.seq
    }))
    first.open(identity, 0)
    // Seed two pending frames without delivering them.
    const outbox = new PtyOwnershipTransferDestinationOutputOutbox({ directory })
    outbox.enqueue(identity, { seq: 1, data: 'one' })
    outbox.enqueue(identity, { seq: 2, data: 'two' })

    const delivered: number[] = []
    const recovered = createSink((_identity, _binding, frame) => {
      delivered.push(frame.seq)
      return { identity, throughSeq: 2 }
    })
    expect(recovered.drain(identity, binding)).toMatchObject({
      acknowledgedEndSeq: 2,
      pendingFrames: []
    })
    expect(delivered).toEqual([1])
  })

  it('retries a backpressured frame after durable ACK frees capacity across restart', () => {
    const failed = createSink(
      (_identity, _binding, frame) => {
        if (frame.seq === 1) {
          throw new Error('surface_temporarily_unavailable')
        }
        throw new Error('frame should not reach delivery while backpressured')
      },
      { maxBytes: 5, maxFrames: 2 }
    )
    failed.open(identity, 0)
    expect(() => failed.publish(identity, binding, { seq: 1, data: '12345' })).toThrow(
      'surface_temporarily_unavailable'
    )
    expect(() => failed.publish(identity, binding, { seq: 2, data: 'next' })).toThrow(
      'pty_ownership_transfer_output_outbox_backpressure'
    )

    const delivered: number[] = []
    const recovered = createSink(
      (_identity, _binding, frame) => {
        delivered.push(frame.seq)
        return { identity, throughSeq: frame.seq }
      },
      { maxBytes: 5, maxFrames: 2 }
    )
    expect(recovered.drain(identity, binding)).toMatchObject({
      acknowledgedEndSeq: 1,
      pendingFrames: []
    })
    expect(recovered.publish(identity, binding, { seq: 2, data: 'next' })).toMatchObject({
      acknowledgedEndSeq: 2,
      pendingFrames: []
    })
    expect(delivered).toEqual([1, 2])
  })

  it('rejects a mismatched source-owner generation without dropping pending output', () => {
    const failed = createSink(() => {
      throw new Error('surface_temporarily_unavailable')
    })
    failed.open(identity, 0)
    expect(() => failed.publish(identity, binding, { seq: 1, data: 'pending' })).toThrow(
      'surface_temporarily_unavailable'
    )

    const mismatchedIdentity = {
      ...identity,
      sourceOwnerGeneration: identity.sourceOwnerGeneration + 1
    }
    expect(() => failed.publish(mismatchedIdentity, binding, { seq: 1, data: 'pending' })).toThrow(
      'pty_ownership_transfer_output_outbox_invalid'
    )
    expect(
      new PtyOwnershipTransferDestinationOutputOutbox({ directory }).load(identity)
    ).toMatchObject({
      acknowledgedEndSeq: 0,
      pendingFrames: [{ seq: 1, data: 'pending' }]
    })
  })
})
