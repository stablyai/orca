import { AppState } from 'react-native'

// Why: connection-log persistence is best-effort — a failed write is only retried
// by the next append, so when a disconnect is the last thing that happens the
// entries explaining it never reach storage. Background is the last point the OS
// still runs JS before it can kill the process, so flush the newest snapshot there.
export function subscribeConnectionLogBackgroundFlush(flush: () => void): () => void {
  const subscription = AppState.addEventListener('change', (next) => {
    if (next === 'background') {
      flush()
    }
  })
  return () => subscription.remove()
}
