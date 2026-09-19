import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-journal'
import { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'

const identity: PtyOwnershipTransferIdentity = {
  bridgeId: 'bridge-1',
  terminalId: 'terminal-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-1'
}

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-transfer-output-outbox-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function createOutbox(
  options: { maxBytes?: number; maxFrames?: number; maxRecords?: number } = {}
) {
  return new PtyOwnershipTransferDestinationOutputOutbox({ directory, ...options })
}

describe('PtyOwnershipTransferDestinationOutputOutbox', () => {
  it('replays accepted output after restart until the durable sink acknowledges it', () => {
    const first = createOutbox()
    expect(first.open(identity, 2)).toMatchObject({
      baseEndSeq: 2,
      acknowledgedEndSeq: 2,
      acceptedEndSeq: 2,
      pendingFrames: []
    })
    expect(first.enqueue(identity, { seq: 3, data: 'third\n' })).toBe('accepted')
    expect(first.enqueue(identity, { seq: 4, data: 'fourth\n' })).toBe('accepted')

    const recovered = createOutbox()
    expect(recovered.open(identity, 2)).toMatchObject({
      acknowledgedEndSeq: 2,
      acceptedEndSeq: 4,
      pendingFrames: [
        { seq: 3, data: 'third\n' },
        { seq: 4, data: 'fourth\n' }
      ]
    })
    expect(recovered.acknowledge(identity, 3)).toMatchObject({
      acknowledgedEndSeq: 3,
      acceptedEndSeq: 4,
      pendingFrames: [{ seq: 4, data: 'fourth\n' }]
    })

    const afterAckRestart = createOutbox()
    expect(afterAckRestart.load(identity)).toMatchObject({
      acknowledgedEndSeq: 3,
      pendingFrames: [{ seq: 4, data: 'fourth\n' }]
    })
    expect(afterAckRestart.enqueue(identity, { seq: 3, data: 'ignored retry' })).toBe(
      'acknowledged'
    )
    expect(afterAckRestart.enqueue(identity, { seq: 4, data: 'fourth\n' })).toBe('duplicate')
  })

  it('fails closed on gaps, conflicting retries, and acknowledgements beyond accepted output', () => {
    const outbox = createOutbox()
    outbox.open(identity, 0)
    expect(() => outbox.enqueue(identity, { seq: 1, data: 'partial', truncated: true })).toThrow(
      'pty_ownership_transfer_output_outbox_frame_invalid'
    )
    expect(() => outbox.enqueue(identity, { seq: 2, data: 'gap' })).toThrow(
      'pty_ownership_transfer_output_outbox_gap'
    )
    outbox.enqueue(identity, { seq: 1, data: 'first' })
    expect(() => outbox.enqueue(identity, { seq: 1, data: 'changed' })).toThrow(
      'pty_ownership_transfer_output_outbox_frame_conflict'
    )
    expect(() => outbox.acknowledge(identity, 2)).toThrow(
      'pty_ownership_transfer_output_outbox_ack_ahead'
    )
  })

  it('applies bounded backpressure without advancing the durable cursor', () => {
    const outbox = createOutbox({ maxBytes: 5, maxFrames: 2 })
    outbox.open(identity, 0)
    outbox.enqueue(identity, { seq: 1, data: '12345' })
    expect(() => outbox.enqueue(identity, { seq: 2, data: '6' })).toThrow(
      'pty_ownership_transfer_output_outbox_backpressure'
    )
    expect(createOutbox({ maxBytes: 5, maxFrames: 2 }).load(identity)).toMatchObject({
      acceptedEndSeq: 1,
      pendingBytes: 5,
      pendingFrames: [{ seq: 1, data: '12345' }]
    })
  })

  it('records a committed replay baseline before accepting live output', () => {
    const outbox = createOutbox()
    outbox.open(identity, 0)
    expect(outbox.markCommittedThrough(identity, 2)).toMatchObject({
      acknowledgedEndSeq: 2,
      acceptedEndSeq: 2,
      pendingFrames: []
    })
    expect(outbox.enqueue(identity, { seq: 3, data: 'live\n' })).toBe('accepted')
  })

  it('persists model checkpoint fragments across restart', () => {
    const first = createOutbox()
    first.open(identity, 1)
    first.recordModelCheckpoint(identity, {
      ptyId: 'pty-1',
      frameSeq: 2,
      fragmentStartSu: 0,
      fragmentEndSu: 5,
      frameLengthSu: 5,
      data: 'hello',
      modelSequenceEnd: 7
    })

    const recovered = createOutbox()
    expect(recovered.loadModelCheckpoints(identity)).toEqual([
      {
        ptyId: 'pty-1',
        frameSeq: 2,
        fragmentStartSu: 0,
        fragmentEndSu: 5,
        frameLengthSu: 5,
        data: 'hello',
        modelSequenceEnd: 7
      }
    ])
    expect(() =>
      recovered.recordModelCheckpoint(identity, {
        ptyId: 'pty-1',
        frameSeq: 2,
        fragmentStartSu: 0,
        fragmentEndSu: 5,
        frameLengthSu: 5,
        data: 'xxxxx',
        modelSequenceEnd: 7
      })
    ).toThrow('pty_ownership_transfer_output_model_checkpoint_conflict')
  })

  it('does not skip an unacknowledged live frame while advancing the baseline', () => {
    const outbox = createOutbox()
    outbox.open(identity, 0)
    outbox.enqueue(identity, { seq: 1, data: 'pending' })
    expect(() => outbox.markCommittedThrough(identity, 2)).toThrow(
      'pty_ownership_transfer_output_outbox_pending_baseline'
    )
  })

  it('fences identity/base changes and corrupt durable state', () => {
    const outbox = createOutbox()
    outbox.open(identity, 2)
    expect(() => outbox.open({ ...identity, ownerLease: 'other-lease' }, 2)).toThrow(
      'pty_ownership_transfer_output_outbox_invalid'
    )
    expect(() => outbox.open(identity, 1)).toThrow(
      'pty_ownership_transfer_output_outbox_base_conflict'
    )

    const record = readdirSync(directory).find((name) => name.endsWith('.json'))
    writeFileSync(join(directory, record!), '{', 'utf8')
    expect(() => createOutbox().load(identity)).toThrow(
      'pty_ownership_transfer_output_outbox_invalid'
    )
  })

  it('bounds the number of recoverable transfer records', () => {
    const outbox = createOutbox({ maxRecords: 1 })
    outbox.open(identity, 0)
    expect(() =>
      outbox.open({ ...identity, bridgeId: 'bridge-2', terminalId: 'terminal-2' }, 0)
    ).toThrow('pty_ownership_transfer_output_outbox_record_capacity')
  })
})
