import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AppState, type AppStateStatus } from 'react-native'

const appStateListeners = new Set<() => void>()
let currentAppState: AppStateStatus | null = AppState.currentState
let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null

function subscribeToAppState(listener: () => void): () => void {
  appStateListeners.add(listener)
  if (!appStateSubscription) {
    currentAppState = AppState.currentState
    appStateSubscription = AppState.addEventListener('change', (nextState) => {
      currentAppState = nextState
      appStateListeners.forEach((notify) => notify())
    })
  }

  return () => {
    appStateListeners.delete(listener)
    if (appStateListeners.size === 0) {
      appStateSubscription?.remove()
      appStateSubscription = null
    }
  }
}

function isAppActive(): boolean {
  return (appStateSubscription ? currentAppState : AppState.currentState) === 'active'
}

// A list-level caller's single tick drives every visible relative-time label.
export function useNow(intervalMs = 30_000, enabled = true): number {
  const appActive = useSyncExternalStore(subscribeToAppState, isAppActive, isAppActive)
  const running = appActive && enabled
  const [now, setNow] = useState(() => Date.now())
  const wasRunningRef = useRef(running)

  useEffect(() => {
    const resumed = running && !wasRunningRef.current
    wasRunningRef.current = running
    if (!running) {
      return
    }
    if (resumed) {
      setNow(Date.now())
    }
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, running])

  return now
}
