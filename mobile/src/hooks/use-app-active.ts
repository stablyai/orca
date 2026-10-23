import { useSyncExternalStore } from 'react'
import { AppState, type AppStateStatus } from 'react-native'

const appStateListeners = new Set<() => void>()
// Read on first subscribe, so importing this module never touches AppState.
let currentAppState: AppStateStatus | null = null
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

/** Whether the app is in the foreground; one AppState listener however many callers. */
export function useAppActive(): boolean {
  return useSyncExternalStore(subscribeToAppState, isAppActive, isAppActive)
}
