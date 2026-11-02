import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { subscribeConnectionRevivalTriggers } from './connection-revival-triggers'
import { recordSocketDeadlineAppState, startSocketDeadlineClock } from './socket-deadline-clock'

type RevivalNudge = Parameters<typeof subscribeConnectionRevivalTriggers>[0]
type AppStateListener = (next: string) => void
type NetworkSnapshot = { isConnected?: boolean; type?: string }
type NetworkListener = (state: NetworkSnapshot) => void

const appStateListeners = new Map<string, Set<AppStateListener>>()
const networkListeners = new Set<NetworkListener>()
const subscriptions = new Set<() => void>()
const appStateRemove = vi.fn()
const networkRemove = vi.fn()

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (event: string, listener: AppStateListener) => {
      const listeners = appStateListeners.get(event) ?? new Set<AppStateListener>()
      appStateListeners.set(event, listeners)
      listeners.add(listener)
      return {
        remove: () => {
          appStateRemove()
          listeners.delete(listener)
        }
      }
    }
  }
}))

vi.mock('expo-network', () => ({
  addNetworkStateListener: (listener: NetworkListener) => {
    networkListeners.add(listener)
    return {
      remove: () => {
        networkRemove()
        networkListeners.delete(listener)
      }
    }
  }
}))

function subscribe(nudge: RevivalNudge): () => void {
  const unsubscribe = subscribeConnectionRevivalTriggers(nudge)
  subscriptions.add(unsubscribe)
  return () => {
    subscriptions.delete(unsubscribe)
    unsubscribe()
  }
}

function emitAppState(next: string): void {
  expect(appStateListeners.get('change')?.size).toBe(1)
  for (const listener of appStateListeners.get('change') ?? []) {
    listener(next)
  }
}

function emitNetwork(state: NetworkSnapshot): void {
  expect(networkListeners.size).toBe(1)
  for (const listener of networkListeners) {
    listener(state)
  }
}

describe('subscribeConnectionRevivalTriggers', () => {
  let nudge: Mock<RevivalNudge>

  beforeEach(() => {
    vi.clearAllMocks()
    appStateListeners.clear()
    networkListeners.clear()
    nudge = vi.fn<RevivalNudge>()
  })

  afterEach(() => {
    for (const unsubscribe of subscriptions) {
      unsubscribe()
    }
    subscriptions.clear()
    expect([...appStateListeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
    expect(networkListeners.size).toBe(0)
    recordSocketDeadlineAppState('active')
    vi.restoreAllMocks()
  })

  it('nudges when the app returns to the foreground, not on background', () => {
    subscribe(nudge)
    emitAppState('background')
    expect(nudge).not.toHaveBeenCalled()
    emitAppState('active')
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenLastCalledWith('app-resume')
  })

  it('does not treat focus or an inactive interruption as a background return', () => {
    subscribe(nudge)
    emitAppState('active')
    emitAppState('inactive')
    emitAppState('active')
    expect(nudge).not.toHaveBeenCalled()

    emitAppState('background')
    emitAppState('inactive')
    emitAppState('active')
    emitAppState('active')
    expect(nudge).toHaveBeenCalledExactlyOnceWith('app-resume')
  })

  it('keeps elapsed background time when a device sleep pauses the monotonic clock', () => {
    let wall = 1_000
    let monotonic = 50
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => wall)
    const monotonicClock = vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    const unsubscribe = subscribe(nudge)
    const elapsed = startSocketDeadlineClock()
    try {
      emitAppState('background')
      wall += 3 * 60 * 60_000
      monotonic += 12_000
      emitAppState('active')
      expect(elapsed()).toBe(3 * 60 * 60_000)
      expect(nudge).toHaveBeenCalledTimes(1)
      expect(nudge).toHaveBeenLastCalledWith('app-resume')
    } finally {
      unsubscribe()
      wallClock.mockRestore()
      monotonicClock.mockRestore()
    }
  })

  it('nudges when the network comes back online', () => {
    subscribe(nudge)
    emitNetwork({ isConnected: false, type: 'NONE' })
    expect(nudge).not.toHaveBeenCalled()
    emitNetwork({ isConnected: true, type: 'WIFI' })
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenLastCalledWith('network-change')
  })

  it('nudges on the first connected network event', () => {
    subscribe(nudge)
    emitNetwork({ isConnected: true, type: 'WIFI' })
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenLastCalledWith('network-change')
  })

  it('nudges on a Wi-Fi to cellular handoff that never reports offline', () => {
    subscribe(nudge)
    emitNetwork({ isConnected: true, type: 'WIFI' })
    nudge.mockClear()
    emitNetwork({ isConnected: true, type: 'CELLULAR' })
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenLastCalledWith('network-change')
  })

  it('nudges on same-type Wi-Fi events because the path may have changed', () => {
    subscribe(nudge)
    emitNetwork({ isConnected: true, type: 'WIFI' })
    emitNetwork({ isConnected: true, type: 'WIFI' })
    expect(nudge.mock.calls).toEqual([['network-change'], ['network-change']])
  })

  it('removes both OS listeners when disposed', () => {
    const unsubscribe = subscribe(nudge)
    unsubscribe()
    expect(appStateRemove).toHaveBeenCalledTimes(1)
    expect(networkRemove).toHaveBeenCalledTimes(1)
  })
})
