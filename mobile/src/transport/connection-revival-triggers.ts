import { AppState } from 'react-native'
import { addNetworkStateListener } from 'expo-network'
import { recordSocketDeadlineAppState } from './socket-deadline-clock'

// Resume/network handoff can kill sockets without close events and suspend retry timers; nudge recovery from OS signals (#5049).
export function subscribeConnectionRevivalTriggers(
  nudge: (reason: 'app-resume' | 'network-change') => void
): () => void {
  recordSocketDeadlineAppState(AppState.currentState)
  let wasBackgrounded = AppState.currentState === 'background'
  const appStateSub = AppState.addEventListener('change', (next) => {
    recordSocketDeadlineAppState(next)
    if (next === 'background') {
      wasBackgrounded = true
    } else if (next === 'active' && wasBackgrounded) {
      wasBackgrounded = false
      nudge('app-resume')
    }
  })
  const networkSub = addNetworkStateListener((state) => {
    if (state.isConnected !== true) {
      return
    }
    // Wi-Fi roaming can replace the TCP path without changing the reported network type.
    console.log('[net] network changed — nudging clients', { type: state.type })
    nudge('network-change')
  })
  return () => {
    appStateSub.remove()
    networkSub.remove()
  }
}
