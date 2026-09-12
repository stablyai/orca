import { AppState } from 'react-native'

export function startMobilePushLeaseRenewal(renew: () => Promise<void>): () => void {
  const refresh = () => {
    if (AppState.currentState === 'active') {
      void renew().catch(() => {})
    }
  }
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      refresh()
    }
  })
  const timer = setInterval(refresh, 15 * 60_000)
  return () => {
    subscription.remove()
    clearInterval(timer)
  }
}
