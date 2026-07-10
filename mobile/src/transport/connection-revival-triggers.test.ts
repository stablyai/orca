import { beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeConnectionRevivalTriggers } from './connection-revival-triggers'

type AppStateListener = (next: string) => void
type NetworkSnapshot = { isConnected?: boolean; type?: string }
type NetworkListener = (state: NetworkSnapshot) => void

let appStateListener: AppStateListener | null = null
let networkListener: NetworkListener | null = null
let seededNetworkState: NetworkSnapshot = { isConnected: true, type: 'WIFI' }
const appStateRemove = vi.fn()
const networkRemove = vi.fn()

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: AppStateListener) => {
      appStateListener = listener
      return { remove: appStateRemove }
    }
  }
}))

vi.mock('expo-network', () => ({
  getNetworkStateAsync: () => Promise.resolve(seededNetworkState),
  addNetworkStateListener: (listener: NetworkListener) => {
    networkListener = listener
    return { remove: networkRemove }
  }
}))

// Why: the baseline seed resolves on a microtask; flush it so listener
// events in the test observe the same ordering as a real subscription.
async function subscribeAndSeed(nudge: () => void): Promise<() => void> {
  const unsubscribe = subscribeConnectionRevivalTriggers(nudge)
  await Promise.resolve()
  return unsubscribe
}

describe('subscribeConnectionRevivalTriggers', () => {
  let nudge: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    appStateListener = null
    networkListener = null
    seededNetworkState = { isConnected: true, type: 'WIFI' }
    nudge = vi.fn()
  })

  it('nudges when the app returns to the foreground, not on background', async () => {
    await subscribeAndSeed(nudge)
    appStateListener?.('background')
    expect(nudge).not.toHaveBeenCalled()
    appStateListener?.('active')
    expect(nudge).toHaveBeenCalledTimes(1)
  })

  it('nudges when the network comes back online', async () => {
    await subscribeAndSeed(nudge)
    networkListener?.({ isConnected: false, type: 'NONE' })
    expect(nudge).not.toHaveBeenCalled()
    networkListener?.({ isConnected: true, type: 'WIFI' })
    expect(nudge).toHaveBeenCalledTimes(1)
  })

  it('nudges when the app started offline and the first event is the recovery', async () => {
    seededNetworkState = { isConnected: false, type: 'NONE' }
    await subscribeAndSeed(nudge)
    networkListener?.({ isConnected: true, type: 'WIFI' })
    expect(nudge).toHaveBeenCalledTimes(1)
  })

  it('nudges on a Wi-Fi to cellular handoff that never reports offline', async () => {
    await subscribeAndSeed(nudge)
    networkListener?.({ isConnected: true, type: 'CELLULAR' })
    expect(nudge).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the network state matches the seeded baseline', async () => {
    await subscribeAndSeed(nudge)
    networkListener?.({ isConnected: true, type: 'WIFI' })
    networkListener?.({ isConnected: true, type: 'WIFI' })
    expect(nudge).not.toHaveBeenCalled()
  })

  it('ignores a stale seed that resolves after unsubscribe', async () => {
    seededNetworkState = { isConnected: false, type: 'NONE' }
    const unsubscribe = subscribeConnectionRevivalTriggers(nudge)
    unsubscribe()
    await Promise.resolve()
    expect(appStateRemove).toHaveBeenCalledTimes(1)
    expect(networkRemove).toHaveBeenCalledTimes(1)
  })
})
