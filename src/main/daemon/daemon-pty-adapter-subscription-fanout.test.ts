import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapterSubscriptionFanout } from './daemon-pty-adapter-subscription-fanout'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonPtyRouterDataEvent, DaemonPtyRouterExitEvent } from './daemon-pty-router-events'

type FakeAdapter = DaemonPtyAdapter & {
  emitData: (payload: DaemonPtyRouterDataEvent) => void
  emitExit: (payload: DaemonPtyRouterExitEvent) => void
}

function fakeAdapter(): { adapter: FakeAdapter; unsubscribeCalls: string[] } {
  const unsubscribeCalls: string[] = []
  let dataListener: ((payload: DaemonPtyRouterDataEvent) => void) | undefined
  let exitListener: ((payload: DaemonPtyRouterExitEvent) => void) | undefined
  const adapter = {
    onData: vi.fn((callback: (payload: DaemonPtyRouterDataEvent) => void) => {
      dataListener = callback
      return () => {
        unsubscribeCalls.push('data')
        dataListener = undefined
      }
    }),
    onExit: vi.fn((callback: (payload: DaemonPtyRouterExitEvent) => void) => {
      exitListener = callback
      return () => {
        unsubscribeCalls.push('exit')
        exitListener = undefined
      }
    }),
    onBackgroundStreamEvent: vi.fn(() => () => {}),
    onWriteUnavailable: vi.fn(() => () => {}),
    emitData: (payload: DaemonPtyRouterDataEvent) => dataListener?.(payload),
    emitExit: (payload: DaemonPtyRouterExitEvent) => exitListener?.(payload)
  } as unknown as FakeAdapter
  return { adapter, unsubscribeCalls }
}

describe('DaemonPtyAdapterSubscriptionFanout.removeAdapter', () => {
  it('unsubscribes only the removed adapter, leaving the others fanning out', () => {
    const retiring = fakeAdapter()
    const surviving = fakeAdapter()
    const onAdapterExit = vi.fn()
    const fanout = new DaemonPtyAdapterSubscriptionFanout(
      [retiring.adapter, surviving.adapter],
      onAdapterExit
    )
    const dataEvents: DaemonPtyRouterDataEvent[] = []
    fanout.onData((payload) => dataEvents.push(payload))

    fanout.removeAdapter(retiring.adapter)

    expect(retiring.unsubscribeCalls).toEqual(expect.arrayContaining(['data', 'exit']))
    expect(surviving.unsubscribeCalls).toEqual([])

    retiring.adapter.emitData({ id: 'retired-session', data: 'ignored' })
    surviving.adapter.emitData({ id: 'live-session', data: 'seen' })
    expect(dataEvents).toEqual([{ id: 'live-session', data: 'seen' }])
  })

  it('is a no-op for an adapter that was never registered', () => {
    const only = fakeAdapter()
    const stranger = fakeAdapter()
    const fanout = new DaemonPtyAdapterSubscriptionFanout([only.adapter], vi.fn())
    expect(() => fanout.removeAdapter(stranger.adapter)).not.toThrow()
    expect(only.unsubscribeCalls).toEqual([])
  })

  it('dispose() still tears down every remaining adapter after a partial removeAdapter', () => {
    const retiring = fakeAdapter()
    const surviving = fakeAdapter()
    const fanout = new DaemonPtyAdapterSubscriptionFanout(
      [retiring.adapter, surviving.adapter],
      vi.fn()
    )
    fanout.removeAdapter(retiring.adapter)
    fanout.dispose()
    expect(surviving.unsubscribeCalls).toEqual(expect.arrayContaining(['data', 'exit']))
  })
})
