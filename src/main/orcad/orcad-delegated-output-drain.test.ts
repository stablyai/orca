import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOrcadDelegatedOutputPump,
  drainOrcadDelegatedOutput
} from './orcad-delegated-output-drain'
import { PtyOwnershipTransferDestinationAdapter } from '../../shared/pty-ownership-transfer-destination-adapter'
import { PtyOwnershipTransferDestinationFileStore } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import { PtyOwnershipTransferDestinationOutputOutbox } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'
import { PtyOwnershipTransferDestinationOutputSink } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-sink'
import {
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

describe('delegated durable output drain', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-delegated-drain-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  })
  function setup() {
    const store = new PtyOwnershipTransferDestinationFileStore({
      directory: join(directory, 'journal')
    })
    const outbox = new PtyOwnershipTransferDestinationOutputOutbox({
      directory: join(directory, 'outbox')
    })
    outbox.open(identity, 0)
    const deliver = vi.fn((_identity, _binding, frame) => ({ identity, throughSeq: frame.seq }))
    const sink = new PtyOwnershipTransferDestinationOutputSink({ outbox, deliver })
    const adapter = new PtyOwnershipTransferDestinationAdapter({
      store,
      publishDurably: (request) => request.publicationReceipt,
      publishPostCommitOutput: (identity, binding, frame) => sink.publish(identity, binding, frame),
      markPostCommitOutputBaseline: (identity, seq) => sink.markCommittedThrough(identity, seq)
    })
    adapter.prepare({
      ...identity,
      version: 1,
      phase: 'prepared',
      surfacePublication: preparation.surfacePublication,
      sourceOutputEndSeq: store.load(identity)?.acceptedSourceEndSeq ?? 0,
      replayStartSeq: 1
    })
    adapter.bindSurface(preparation.surfacePublication.surfaceBinding)
    let active = true
    const drain = () =>
      drainOrcadDelegatedOutput({ identity, adapter, outbox, isActive: () => active })
    const commit = (seq: number) =>
      adapter.commit({
        bridgeId: identity.bridgeId,
        receiptId: 'receipt',
        acceptedSourceEndSeq: seq,
        committedAt: '2026-09-06T00:00:00.000Z'
      })
    return {
      store,
      outbox,
      adapter,
      deliver,
      drain,
      commit,
      deactivate: () => {
        active = false
      }
    }
  }

  it('stages bounded replay then delivers post-commit output through the existing sink', async () => {
    const fixture = setup()
    for (let seq = 1; seq <= 33; seq++) {
      fixture.outbox.enqueue(identity, { seq, data: String(seq) })
    }
    expect(await fixture.drain()).toEqual({ drained: 32, acknowledgedEndSeq: 32, hasPending: true })
    expect(fixture.deliver).not.toHaveBeenCalled()
    expect(await fixture.drain()).toEqual({ drained: 1, acknowledgedEndSeq: 33, hasPending: false })
    expect(fixture.store.loadFrames(identity)).toHaveLength(33)
    fixture.commit(33)
    fixture.outbox.enqueue(identity, { seq: 34, data: 'live' })
    expect(await fixture.drain()).toMatchObject({ acknowledgedEndSeq: 34, hasPending: false })
    expect(fixture.deliver).toHaveBeenCalledOnce()
  })

  it('does not acknowledge replay when durable staging fails', async () => {
    const fixture = setup()
    fixture.outbox.enqueue(identity, { seq: 1, data: 'first' })
    vi.spyOn(fixture.store, 'appendFrame').mockImplementationOnce(() => {
      throw new Error('staging failed')
    })
    await expect(fixture.drain()).rejects.toThrow('staging failed')
    expect(fixture.outbox.load(identity)?.pendingFrames).toHaveLength(1)
    expect(await fixture.drain()).toMatchObject({ acknowledgedEndSeq: 1 })
  })

  it('retries already-staged replay after outbox ACK failure without duplicating history', async () => {
    const fixture = setup()
    fixture.outbox.enqueue(identity, { seq: 1, data: 'first' })
    vi.spyOn(fixture.outbox, 'acknowledge').mockImplementationOnce(() => {
      throw new Error('ack failed')
    })
    await expect(fixture.drain()).rejects.toThrow('ack failed')
    expect(await fixture.drain()).toMatchObject({ acknowledgedEndSeq: 1 })
    expect(fixture.store.loadFrames(identity)).toEqual([{ seq: 1, data: 'first' }])
  })

  it('retains committed output when model delivery fails', async () => {
    const fixture = setup()
    fixture.commit(0)
    fixture.outbox.enqueue(identity, { seq: 1, data: 'live' })
    fixture.deliver.mockImplementationOnce(() => {
      throw new Error('model unavailable')
    })
    await expect(fixture.drain()).rejects.toThrow('model unavailable')
    expect(fixture.outbox.load(identity)?.pendingFrames).toHaveLength(1)
    expect(await fixture.drain()).toMatchObject({ acknowledgedEndSeq: 1 })
  })

  it('leaves outbox frames untouched after claim deactivation', async () => {
    const fixture = setup()
    fixture.outbox.enqueue(identity, { seq: 1, data: 'first' })
    fixture.deactivate()
    expect(await fixture.drain()).toEqual({ drained: 0, acknowledgedEndSeq: 0, hasPending: true })
    expect(fixture.store.loadFrames(identity)).toEqual([])
  })

  it('retains staged replay if the claim changes before releasing the outbox frame', async () => {
    const fixture = setup()
    fixture.outbox.enqueue(identity, { seq: 1, data: 'first' })
    const append = fixture.store.appendFrame.bind(fixture.store)
    vi.spyOn(fixture.store, 'appendFrame').mockImplementationOnce((identity, frame) => {
      const journal = append(identity, frame)
      fixture.deactivate()
      return journal
    })
    expect(await fixture.drain()).toEqual({ drained: 0, acknowledgedEndSeq: 0, hasPending: true })
    expect(fixture.store.loadFrames(identity)).toEqual([{ seq: 1, data: 'first' }])
    expect(fixture.outbox.load(identity)?.pendingFrames).toHaveLength(1)
    const reopened = setup()
    expect(await reopened.drain()).toMatchObject({ acknowledgedEndSeq: 1, hasPending: false })
    expect(reopened.store.loadFrames(identity)).toEqual([{ seq: 1, data: 'first' }])
  })

  function pumpFixture(
    prepareModelFrame?: (frame: Readonly<{ seq: number; data: string }>) => Promise<void>
  ) {
    vi.useFakeTimers()
    const fixture = setup()
    const onError = vi.fn()
    const pump = createOrcadDelegatedOutputPump({
      identity,
      adapter: fixture.adapter,
      outbox: fixture.outbox,
      isActive: () => true,
      prepareModelFrame,
      onError
    })
    return { ...fixture, pump, onError }
  }

  it('serializes model preparation and coalesces wakes while awaiting completion', async () => {
    let finish!: () => void
    const prepare = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const fixture = pumpFixture(prepare)
    fixture.commit(0)
    fixture.outbox.enqueue(identity, { seq: 1, data: 'live' })
    fixture.pump.wake()
    await vi.advanceTimersToNextTimerAsync()
    fixture.pump.wake()
    fixture.pump.wake()
    expect(prepare).toHaveBeenCalledOnce()
    expect(fixture.deliver).not.toHaveBeenCalled()
    expect(fixture.outbox.load(identity)?.acknowledgedEndSeq).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    finish()
    await vi.runAllTimersAsync()
    expect(fixture.deliver).toHaveBeenCalledOnce()
    expect(fixture.outbox.load(identity)?.acknowledgedEndSeq).toBe(1)
    expect(prepare).toHaveBeenCalledOnce()
    fixture.pump.dispose()
  })

  it('does not deliver or acknowledge a completed model write after disposal', async () => {
    let finish!: () => void
    const fixture = pumpFixture(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    fixture.commit(0)
    fixture.outbox.enqueue(identity, { seq: 1, data: 'live' })
    fixture.pump.wake()
    await vi.advanceTimersToNextTimerAsync()
    const stopped = vi.fn()
    const stopping = fixture.pump.dispose().then(stopped)
    await Promise.resolve()
    expect(stopped).not.toHaveBeenCalled()
    finish()
    await stopping
    await vi.runAllTimersAsync()
    expect(fixture.deliver).not.toHaveBeenCalled()
    expect(fixture.outbox.load(identity)?.pendingFrames).toHaveLength(1)
    expect(fixture.onError).not.toHaveBeenCalled()
  })

  it('retains output on async model failure without spinning', async () => {
    const prepare = vi
      .fn()
      .mockRejectedValueOnce(new Error('checkpoint failed'))
      .mockResolvedValue(undefined)
    const fixture = pumpFixture(prepare)
    fixture.commit(0)
    fixture.outbox.enqueue(identity, { seq: 1, data: 'live' })
    fixture.pump.wake()
    await vi.runAllTimersAsync()
    expect(fixture.onError).toHaveBeenCalledOnce()
    expect(fixture.deliver).not.toHaveBeenCalled()
    expect(fixture.outbox.load(identity)?.pendingFrames).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    fixture.pump.wake()
    await vi.runAllTimersAsync()
    expect(fixture.outbox.load(identity)?.acknowledgedEndSeq).toBe(1)
    fixture.pump.dispose()
  })

  it('refuses a claim replaced during model preparation', async () => {
    const fixture = setup()
    fixture.commit(0)
    fixture.adapter.bindDelegatedExecution({ generation: 1, claimId: 'first' })
    fixture.outbox.enqueue(identity, { seq: 1, data: 'live' })
    await expect(
      drainOrcadDelegatedOutput({
        identity,
        adapter: fixture.adapter,
        outbox: fixture.outbox,
        isActive: () => true,
        prepareModelFrame: async () => {
          fixture.adapter.bindDelegatedExecution({ generation: 2, claimId: 'replacement' })
        }
      })
    ).rejects.toThrow('orcad_delegated_output_destination_changed')
    expect(fixture.deliver).not.toHaveBeenCalled()
    expect(fixture.outbox.load(identity)?.pendingFrames).toHaveLength(1)
  })

  it('coalesces wakes and yields between bounded backlog batches', async () => {
    const fixture = pumpFixture()
    for (let seq = 1; seq <= 33; seq++) {
      fixture.outbox.enqueue(identity, { seq, data: String(seq) })
      fixture.pump.wake()
    }
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersToNextTimer()
    await Promise.resolve()
    expect(fixture.outbox.load(identity)?.acknowledgedEndSeq).toBe(32)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersToNextTimerAsync()
    expect(fixture.outbox.load(identity)?.acknowledgedEndSeq).toBe(33)
    expect(vi.getTimerCount()).toBe(0)
    expect(fixture.onError).not.toHaveBeenCalled()
    fixture.pump.dispose()
  })

  it('retains failed delivery without a retry spin and resumes on wake', async () => {
    const fixture = pumpFixture()
    fixture.commit(0)
    fixture.outbox.enqueue(identity, { seq: 1, data: 'live' })
    fixture.deliver.mockImplementationOnce(() => {
      throw new Error('model unavailable')
    })
    fixture.pump.wake()
    await vi.runAllTimersAsync()
    expect(fixture.onError).toHaveBeenCalledOnce()
    expect(fixture.outbox.load(identity)?.pendingFrames).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    fixture.pump.wake()
    await vi.runAllTimersAsync()
    expect(fixture.outbox.load(identity)?.acknowledgedEndSeq).toBe(1)
    fixture.pump.dispose()
  })

  it('cancels scheduled delivery and ignores later wakes after disposal', async () => {
    const fixture = pumpFixture()
    fixture.outbox.enqueue(identity, { seq: 1, data: 'first' })
    fixture.pump.wake()
    fixture.pump.dispose()
    fixture.pump.wake()
    await vi.runAllTimersAsync()
    expect(fixture.store.loadFrames(identity)).toEqual([])
    expect(fixture.outbox.load(identity)?.pendingFrames).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
