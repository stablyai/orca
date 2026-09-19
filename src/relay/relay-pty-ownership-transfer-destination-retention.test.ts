import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_ACK_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_REPLAY_METHOD,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD
} from '../shared/pty-ownership-transfer-destination-claim'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  context,
  identity,
  makeDelegatedRelay,
  preparation,
  request
} from './relay-pty-ownership-transfer-delegation-test-fixture'

describe('delegated source ACK-aware retention', () => {
  let directory: string
  let store: RelayPtyOwnershipTransferFileStore
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-output-retention-'))
    store = new RelayPtyOwnershipTransferFileStore(directory)
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  function setup(routes = false) {
    const adapter = makeDelegatedRelay(store, {
      enableDestinationOutputRetention: true,
      enableDestinationOutputRoutes: routes,
      replayBytes: 6
    })
    const handlers = new Map<string, MethodHandler>()
    const publishProducerNotification = vi.fn<RelayDispatcher['publishProducerNotification']>(
      () => true
    )
    let capacity = () => {}
    let dispose = () => {}
    const detachListeners = new Set<(clientId: number) => void>()
    const removeCapacity = vi.fn()
    const removeDetach = vi.fn()
    const removeDispose = vi.fn()
    adapter.register({
      onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler),
      publishProducerNotification,
      onLegacyPtyCapacity: (listener: () => void) => {
        capacity = listener
        return removeCapacity
      },
      onClientDetached: (listener: (clientId: number) => void) => {
        detachListeners.add(listener)
        return () => {
          detachListeners.delete(listener)
          removeDetach()
        }
      },
      onDisposed: (listener: () => void) => {
        dispose = listener
        return removeDispose
      }
    } as unknown as RelayDispatcher)
    const params = (afterSeq: number, generation = 1) => ({
      ...request(generation),
      afterSeq,
      destinationClaim: { generation, claimId: `claim-${generation}` }
    })
    return {
      adapter,
      publishProducerNotification,
      capacity: () => capacity(),
      dispose: () => dispose(),
      detach: (clientId: number) => {
        for (const listener of detachListeners) {
          listener(clientId)
        }
      },
      removers: [removeCapacity, removeDetach, removeDispose],
      subscribe: (afterSeq: number, generation = 1) =>
        handlers.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD)!(
          params(afterSeq, generation),
          context()
        ),
      replay: (afterSeq: number, generation = 1) =>
        handlers.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_REPLAY_METHOD)!(
          params(afterSeq, generation),
          context()
        ),
      ack: (afterSeq: number, generation = 1) =>
        handlers.get(PTY_OWNERSHIP_TRANSFER_DESTINATION_ACK_METHOD)!(
          params(afterSeq, generation),
          context()
        )
    }
  }

  it('backpressures before eviction, then admits exact next output after cumulative ACK', async () => {
    const { adapter, replay, ack } = setup()
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    adapter.observeOutput(identity.terminalId, 'first')
    const before = store.loadAll()
    expect(before[0]).toMatchObject({ version: 4, destinationOutputRetention: true })
    expect(() => adapter.observeOutput(identity.terminalId, 'second')).toThrow('output_capacity')
    expect(store.loadAll()).toEqual(before)
    await expect(ack(1)).rejects.toThrow('ack_unsent')
    await replay(0)
    await expect(ack(1)).resolves.toMatchObject({ acknowledgedThroughSeq: 1 })
    adapter.observeOutput(identity.terminalId, 'second')
    expect(store.loadAll()[0].history.frames).toEqual([{ seq: 2, data: 'second' }])
    await expect(replay(0)).rejects.toThrow('no longer retained')
    await expect(replay(1)).resolves.toMatchObject({ frames: [{ seq: 2, data: 'second' }] })
  })

  it('does not acknowledge skipped frames or inherit delivery proof from a superseded claim', async () => {
    const { adapter, replay, ack } = setup()
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    adapter.observeOutput(identity.terminalId, 'one')
    adapter.observeOutput(identity.terminalId, 'two')
    await replay(1)
    await expect(ack(2)).rejects.toThrow('ack_unsent')
    await replay(0)
    adapter.claimDestination(request(2), context())
    await expect(ack(2)).rejects.toThrow('ack_unavailable')
    await expect(ack(2, 2)).rejects.toThrow('ack_unsent')
    await replay(0, 2)
    await expect(ack(2, 2)).resolves.toMatchObject({ acknowledgedThroughSeq: 2 })
  })

  it('restores conservative retention after restart, requiring replay and a new claim', async () => {
    const first = setup()
    first.adapter.prepare(preparation)
    first.adapter.claimDestination(request(), context())
    first.adapter.observeOutput(identity.terminalId, 'first')
    await first.replay(0)
    await first.ack(1)
    const restored = setup()
    expect(() => restored.adapter.observeOutput(identity.terminalId, 'second')).toThrow(
      'output_capacity'
    )
    await expect(restored.ack(1)).rejects.toThrow('ack_unavailable')
    restored.adapter.claimDestination(request(2), context())
    await restored.replay(0, 2)
    await restored.ack(1, 2)
    restored.adapter.observeOutput(identity.terminalId, 'second')
    expect(store.loadAll()[0].history.frames).toEqual([{ seq: 2, data: 'second' }])
  })

  it('counts UTF-8 bytes and leaves sequence unchanged on oversized admission', () => {
    const { adapter } = setup()
    adapter.prepare(preparation)
    expect(() => adapter.observeOutput(identity.terminalId, '😀😀')).toThrow('output_capacity')
    adapter.observeOutput(identity.terminalId, '😀')
    expect(store.loadAll()[0].history.frames).toEqual([{ seq: 1, data: '😀' }])
  })

  it('streams retained and new frames through bounded targeted publication and durable ACK', async () => {
    vi.useFakeTimers()
    try {
      const { adapter, subscribe, ack, capacity, publishProducerNotification } = setup(true)
      adapter.prepare(preparation)
      adapter.claimDestination(request(), context())
      adapter.observeOutput(identity.terminalId, 'first')
      publishProducerNotification.mockReturnValueOnce(false)
      await subscribe(0)
      vi.advanceTimersByTime(1)
      await expect(ack(1)).rejects.toThrow('ack_unsent')
      capacity()
      vi.advanceTimersByTime(1)
      expect(publishProducerNotification).toHaveBeenCalledTimes(2)
      expect(publishProducerNotification.mock.calls[1][0]).toBe(context().clientId)
      expect(publishProducerNotification.mock.calls[1][2]).toMatchObject({
        frame: { seq: 1, data: 'first' }
      })
      await ack(1)
      adapter.observeOutput(identity.terminalId, 'second')
      vi.advanceTimersByTime(1)
      expect(publishProducerNotification.mock.calls[2][2]).toMatchObject({
        frame: { seq: 2, data: 'second' }
      })
      adapter.claimDestination(request(2), context())
      capacity()
      vi.advanceTimersByTime(1)
      expect(publishProducerNotification).toHaveBeenCalledTimes(3)
      await expect(ack(2)).rejects.toThrow('ack_unavailable')
      await subscribe(1, 2)
      vi.advanceTimersByTime(1)
      await expect(ack(2, 2)).resolves.toMatchObject({ acknowledgedThroughSeq: 2 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases retention after durable abort instead of waiting for a revoked destination', async () => {
    const { adapter, ack } = setup()
    adapter.prepare(preparation)
    adapter.claimDestination(request(), context())
    adapter.observeOutput(identity.terminalId, 'first')
    adapter.abort(preparation)
    adapter.observeOutput(identity.terminalId, 'second')
    expect(store.loadAll()[0].history.frames).toEqual([{ seq: 2, data: 'second' }])
    await expect(ack(2)).rejects.toThrow('claim_unavailable')
  })

  it('disposes queued delivery and listeners without changing retained output', async () => {
    vi.useFakeTimers()
    try {
      const first = setup(true)
      first.adapter.prepare(preparation)
      first.adapter.claimDestination(request(), context())
      first.adapter.observeOutput(identity.terminalId, 'first')
      await first.subscribe(0)
      const before = store.loadAll()
      expect(vi.getTimerCount()).toBe(1)
      first.dispose()
      expect(vi.getTimerCount()).toBe(0)
      first.capacity()
      vi.runAllTimers()
      expect(first.publishProducerNotification).not.toHaveBeenCalled()
      for (const remove of first.removers) {
        expect(remove).toHaveBeenCalledOnce()
      }
      await expect(first.subscribe(0)).rejects.toThrow('subscription_unavailable')
      expect(store.loadAll()).toEqual(before)

      const restored = setup(true)
      restored.adapter.claimDestination(request(2), context())
      await restored.subscribe(0, 2)
      vi.runAllTimers()
      expect(restored.publishProducerNotification.mock.calls[0][2]).toMatchObject({
        frame: { seq: 1, data: 'first' }
      })
      await restored.ack(1, 2)
      restored.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('only cancels queued output for the detached destination client', async () => {
    vi.useFakeTimers()
    try {
      const fixture = setup(true)
      fixture.adapter.prepare(preparation)
      fixture.adapter.claimDestination(request(), context())
      fixture.adapter.observeOutput(identity.terminalId, 'first')
      await fixture.subscribe(0)
      fixture.detach(context().clientId + 1)
      expect(vi.getTimerCount()).toBe(1)
      fixture.detach(context().clientId)
      expect(vi.getTimerCount()).toBe(0)
      fixture.capacity()
      vi.runAllTimers()
      expect(fixture.publishProducerNotification).not.toHaveBeenCalled()
      expect(store.loadAll()[0].history.frames).toEqual([{ seq: 1, data: 'first' }])
      fixture.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
