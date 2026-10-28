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
let seededNetworkState: NetworkSnapshot = { isConnected: true, type: 'WIFI' }
let readNetworkState = () => Promise.resolve(seededNetworkState)
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
  getNetworkStateAsync: () => readNetworkState(),
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

async function subscribeAndSeed(nudge: RevivalNudge): Promise<() => void> {
  const unsubscribe = subscribe(nudge)
  await Promise.resolve()
  return unsubscribe
}

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
    readNetworkState = () => Promise.resolve(seededNetworkState)
    seededNetworkState = { isConnected: true, type: 'WIFI' }
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

  it('nudges when the app returns to the foreground, not on background', async () => {
    await subscribeAndSeed(nudge)
    emitAppState('background')
    expect(nudge).not.toHaveBeenCalled()
    emitAppState('active')
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenLastCalledWith('app-resume')
  })

  it('keeps elapsed background time when a device sleep pauses the monotonic clock', async () => {
    let wall = 1_000
    let monotonic = 50
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => wall)
    const monotonicClock = vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
    const unsubscribe = await subscribeAndSeed(nudge)
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

  it('nudges when the network comes back online', async () => {
    await subscribeAndSeed(nudge)
    emitNetwork({ isConnected: false, type: 'NONE' })
    expect(nudge).not.toHaveBeenCalled()
    emitNetwork({ isConnected: true, type: 'WIFI' })
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenLastCalledWith('network-change')
  })

  it('nudges when the app started offline and the first event is the recovery', async () => {
    seededNetworkState = { isConnected: false, type: 'NONE' }
    await subscribeAndSeed(nudge)
    emitNetwork({ isConnected: true, type: 'WIFI' })
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenLastCalledWith('network-change')
  })

  it('nudges on a Wi-Fi to cellular handoff that never reports offline', async () => {
    await subscribeAndSeed(nudge)
    emitNetwork({ isConnected: true, type: 'CELLULAR' })
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenLastCalledWith('network-change')
  })

  it('stays quiet when the network state matches the seeded baseline', async () => {
    await subscribeAndSeed(nudge)
    emitNetwork({ isConnected: true, type: 'WIFI' })
    emitNetwork({ isConnected: true, type: 'WIFI' })
    expect(nudge).not.toHaveBeenCalled()
  })

  it('keeps a newer network event when a stale seed resolves later', async () => {
    let finishSeed: (state: NetworkSnapshot) => void = () => {}
    const pendingSeed = new Promise<NetworkSnapshot>((resolve) => {
      finishSeed = resolve
    })
    readNetworkState = () => pendingSeed
    const unsubscribe = subscribe(nudge)
    emitNetwork({ isConnected: true, type: 'CELLULAR' })
    finishSeed({ isConnected: true, type: 'WIFI' })
    await Promise.resolve()
    emitNetwork({ isConnected: true, type: 'CELLULAR' })
    expect(nudge).not.toHaveBeenCalled()
    emitNetwork({ isConnected: true, type: 'WIFI' })
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenLastCalledWith('network-change')
    unsubscribe()
    expect(appStateRemove).toHaveBeenCalledTimes(1)
    expect(networkRemove).toHaveBeenCalledTimes(1)
  })
})
