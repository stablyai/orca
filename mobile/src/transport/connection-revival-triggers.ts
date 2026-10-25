import { AppState } from 'react-native'
import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network'
import { recordSocketDeadlineAppState } from './socket-deadline-clock'

// Resume/network handoff can kill sockets without close events and suspend retry timers; nudge recovery from OS signals (#5049).
export function subscribeConnectionRevivalTriggers(
  nudge: (reason: 'app-resume' | 'network-change') => void
): () => void {
  recordSocketDeadlineAppState(AppState.currentState)
  const appStateSub = AppState.addEventListener('change', (next) => {
    recordSocketDeadlineAppState(next)
    if (next === 'active') {
      nudge('app-resume')
    }
  })
  let lastNetwork: Pick<NetworkState, 'isConnected' | 'type'> | null = null
  let disposed = false
  // Seed the baseline so the first offline-to-online change is not swallowed.
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
    // A Wi-Fi/cellular handoff can kill TCP while connectivity stays true.
    const switchedNetworks = previous?.type != null && state.type !== previous.type
    if (cameOnline || switchedNetworks) {
      console.log('[net] network changed — nudging clients', {
        type: state.type,
        cameOnline
      })
      nudge('network-change')
    }
  })
  return () => {
    disposed = true
    appStateSub.remove()
    networkSub.remove()
  }
}
