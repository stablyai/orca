import { AppState } from 'react-native'

// Retry failed log persistence before background suspension can prevent the next append.
export function subscribeConnectionLogBackgroundFlush(flush: () => void): () => void {
  const subscription = AppState.addEventListener('change', (next) => {
    if (next === 'background') {
      flush()
    }
  })
  return () => subscription.remove()
}
