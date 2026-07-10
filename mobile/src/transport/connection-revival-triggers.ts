import { AppState } from 'react-native'
import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network'

// Why: Android/iOS suspend JS timers and silently kill sockets while the app
// is backgrounded, and network handoffs (Wi-Fi → cellular) kill the TCP path
// without an onclose. Both leave clients waiting out long backoff timers or
// parked at the reconnect give-up cap (issue #5049). Surface every "the link
// probably just came back" OS signal as a single nudge callback.
export function subscribeConnectionRevivalTriggers(nudge: () => void): () => void {
  const appStateSub = AppState.addEventListener('change', (next) => {
    if (next === 'active') {
      nudge()
    }
  })
  let lastNetwork: Pick<NetworkState, 'isConnected' | 'type'> | null = null
  let disposed = false
  // Why: the listener only fires on *changes*; without a seeded baseline the
  // first change after subscribing (app launched offline, network returns)
  // would be swallowed by the previous == null guard below.
  void getNetworkStateAsync()
    .then((state) => {
      if (!disposed && lastNetwork == null) {
        lastNetwork = { isConnected: state.isConnected, type: state.type }
      }
    })
    .catch(() => {})
  const networkSub = addNetworkStateListener((state) => {
    const previous = lastNetwork
    lastNetwork = { isConnected: state.isConnected, type: state.type }
    if (state.isConnected !== true) {
      return
    }
    const cameOnline = previous != null && previous.isConnected !== true
    // Why: a type change while staying "connected" is the Wi-Fi → cellular
    // handoff case — the old socket is dead even though we never went offline.
    const switchedNetworks = previous?.type != null && state.type !== previous.type
    if (cameOnline || switchedNetworks) {
      console.log('[net] network changed — nudging clients', {
        type: state.type,
        cameOnline
      })
      nudge()
    }
  })
  return () => {
    disposed = true
    appStateSub.remove()
    networkSub.remove()
  }
}
