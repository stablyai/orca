import { describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyAdapterSubscriptionFanout } from './daemon-pty-adapter-subscription-fanout'
import type { DaemonPtyRouterDataEvent, DaemonPtyRouterExitEvent } from './daemon-pty-router-events'

function fakeAdapter(): {
  adapter: DaemonPtyAdapter
  emitData: (payload: DaemonPtyRouterDataEvent) => void
  emitExit: (payload: DaemonPtyRouterExitEvent) => void
  unsubscribed: () => number
} {
  const dataListeners = new Set<(payload: DaemonPtyRouterDataEvent) => void>()
  const exitListeners = new Set<(payload: DaemonPtyRouterExitEvent) => void>()
  let unsubscribed = 0
  const release = (listeners: { clear: () => void }): (() => void) => {
    return () => {
      listeners.clear()
      unsubscribed += 1
    }
  }
  return {
    unsubscribed: () => unsubscribed,
    emitData: (payload) => {
      for (const listener of dataListeners) {
        listener(payload)
      }
    },
    emitExit: (payload) => {
      for (const listener of exitListeners) {
        listener(payload)
      }
    },
    adapter: {
      onData: (callback) => {
        dataListeners.add(callback)
        return release(dataListeners)
      },
      onExit: (callback) => {
        exitListeners.add(callback)
        return release(exitListeners)
      }
    } as DaemonPtyAdapter
  }
}

describe('DaemonPtyAdapterSubscriptionFanout.dropAdapter', () => {
  it('unsubscribes a dropped adapter so later data and exit events are not forwarded', () => {
    const dropped = fakeAdapter()
    const kept = fakeAdapter()
    const onAdapterExit = vi.fn()
    const fanout = new DaemonPtyAdapterSubscriptionFanout(
      [dropped.adapter, kept.adapter],
      onAdapterExit
    )
    const data: string[] = []
    const exits: string[] = []
    fanout.onData((payload) => data.push(payload.data))
    fanout.onExit((payload) => exits.push(payload.id))

    dropped.emitData({ id: 'gone', data: 'before' })
    fanout.dropAdapter(dropped.adapter)
    dropped.emitData({ id: 'gone', data: 'after' })
    dropped.emitExit({ id: 'gone', code: 0 })
    kept.emitData({ id: 'live', data: 'kept' })
    kept.emitExit({ id: 'live', code: 0 })

    expect(dropped.unsubscribed()).toBe(2)
    expect(data).toEqual(['before', 'kept'])
    expect(exits).toEqual(['live'])
    expect(onAdapterExit).toHaveBeenCalledTimes(1)
    expect(onAdapterExit).toHaveBeenCalledWith('live')

    fanout.dispose()
    expect(dropped.unsubscribed()).toBe(2)
    expect(kept.unsubscribed()).toBe(2)
  })
})
