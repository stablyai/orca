import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installOrcadDelegatedOutputReceiver } from './orcad-delegated-output-receiver'
import { PtyOwnershipTransferDestinationOutputOutbox } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'
import { identity, request } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

describe('host-local durable delegated output receiver', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-output-receiver-'))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))
  function setup() {
    const outbox = new PtyOwnershipTransferDestinationOutputOutbox({ directory })
    let receive: (params: Record<string, unknown>) => void = () => {}
    const remove = vi.fn()
    const removeDispose = vi.fn()
    let disconnect = () => {}
    const rpc = vi.fn<SshChannelMultiplexer['request']>(async (_method, params) => ({
      ...identity,
      version: 1,
      acknowledgedThroughSeq: params?.afterSeq
    }))
    const onError = vi.fn()
    const onAcknowledged = vi.fn()
    let active = true
    const proof = {
      ...request(),
      afterSeq: 0,
      destinationClaim: { generation: 1, claimId: 'claim-1' }
    }
    const receiver = installOrcadDelegatedOutputReceiver({
      outbox,
      proof,
      baseEndSeq: 0,
      multiplexer: {
        request: rpc,
        onDispose: (listener) => {
          disconnect = () => listener('connection_lost')
          return removeDispose
        },
        onNotificationByMethod: (_method, listener) => {
          receive = listener
          return remove
        }
      },
      isActive: () => active,
      onError,
      onAcknowledged
    })
    return {
      outbox,
      rpc,
      onError,
      onAcknowledged,
      remove,
      removeDispose,
      disconnect: () => disconnect(),
      receiver,
      deactivate: () => {
        active = false
      },
      emit: (seq: number, data: string, patch: Record<string, unknown> = {}) =>
        receive({
          ...identity,
          version: 1,
          destinationClaim: proof.destinationClaim,
          frame: { seq, data },
          ...patch
        })
    }
  }

  it('persists before ACK and bounds concurrent ACK requests', async () => {
    const { outbox, rpc, emit, onAcknowledged } = setup()
    let settle: (() => void) | undefined
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({ ...identity, version: 1, acknowledgedThroughSeq: 1 })
        })
    )
    emit(1, 'one')
    expect(outbox.load(identity)?.acceptedEndSeq).toBe(1)
    emit(2, 'two')
    expect(outbox.load(identity)?.acceptedEndSeq).toBe(2)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(onAcknowledged).not.toHaveBeenCalled()
    settle!()
    await Promise.resolve()
    expect(onAcknowledged).toHaveBeenCalledOnce()
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls[1][1]).toMatchObject({ afterSeq: 2 })
    expect(
      new PtyOwnershipTransferDestinationOutputOutbox({ directory })
        .load(identity)
        ?.pendingFrames.map((frame) => frame.data)
    ).toEqual(['one', 'two'])
  })

  it.each(['invalid', 'disposed'])(
    'does not wake commit reconciliation on an %s ACK reply',
    async (mode) => {
      const fixture = setup()
      fixture.rpc.mockImplementation(async () => {
        if (mode === 'disposed') {
          fixture.deactivate()
        }
        return { ...identity, version: 1, acknowledgedThroughSeq: mode === 'invalid' ? 2 : 1 }
      })
      fixture.emit(1, 'one')
      await Promise.resolve()
      expect(fixture.onAcknowledged).not.toHaveBeenCalled()
    }
  )

  it('does not ACK failed persistence, wrong claims, invalid frames or gaps', () => {
    const { outbox, rpc, emit, onError } = setup()
    emit(1, 'wrong', { destinationClaim: { generation: 2, claimId: 'claim-2' } })
    emit(1, 'wrong', { incarnationId: 'other' })
    emit(0, 'invalid')
    emit(2, 'gap')
    const enqueue = vi.spyOn(outbox, 'enqueue').mockImplementationOnce(() => {
      throw new Error('disk failed')
    })
    emit(1, 'one')
    expect(rpc).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(3)
    enqueue.mockRestore()
    emit(1, 'one')
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('retries failed ACK without duplicating stored frames and fences disposal', async () => {
    const { outbox, rpc, emit, onError, receiver, remove } = setup()
    rpc.mockRejectedValueOnce(new Error('connection lost'))
    emit(1, 'one')
    await Promise.resolve()
    expect(onError).toHaveBeenCalledTimes(1)
    receiver.retryAcknowledgement()
    await Promise.resolve()
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(outbox.load(identity)?.pendingFrames).toHaveLength(1)
    receiver.dispose()
    emit(2, 'two')
    receiver.retryAcknowledgement()
    expect(remove).toHaveBeenCalledOnce()
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it.each([
    undefined,
    {},
    { ...identity, version: 2, acknowledgedThroughSeq: 1 },
    { ...identity, version: 1, acknowledgedThroughSeq: 2 },
    { ...identity, version: 1, acknowledgedThroughSeq: 1, ownerLease: 'wrong' }
  ])('keeps malformed or mismatched ACK responses retryable %#', async (response) => {
    const { rpc, emit, receiver, onError, outbox } = setup()
    rpc.mockResolvedValueOnce(response)
    emit(1, 'one')
    await Promise.resolve()
    expect(onError).toHaveBeenCalledTimes(1)
    receiver.retryAcknowledgement()
    await Promise.resolve()
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(outbox.load(identity)?.pendingFrames).toEqual([{ seq: 1, data: 'one' }])
  })

  it('automatically fences receive and ACK retries on transport disposal', async () => {
    const fixture = setup()
    fixture.rpc.mockRejectedValueOnce(new Error('connection lost'))
    fixture.emit(1, 'first')
    await Promise.resolve()
    fixture.disconnect()
    fixture.emit(2, 'late')
    fixture.receiver.retryAcknowledgement()
    fixture.receiver.dispose()
    expect(fixture.rpc).toHaveBeenCalledOnce()
    expect(fixture.outbox.load(identity)?.pendingFrames).toEqual([{ seq: 1, data: 'first' }])
    expect(fixture.remove).toHaveBeenCalledOnce()
    expect(fixture.removeDispose).toHaveBeenCalledOnce()
  })
})
