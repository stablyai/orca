import { AppState, type AppStateStatus } from 'react-native'

const APP_STATE_STATUSES: ReadonlySet<string> = new Set<AppStateStatus>([
  'active',
  'background',
  'inactive',
  'extension',
  'unknown'
])

function isAppStateStatus(value: string): value is AppStateStatus {
  return APP_STATE_STATUSES.has(value)
}

// RN 0.88 types AppState.currentState as an arbitrary string; narrow it to the documented statuses.
export function currentAppStateStatus(): AppStateStatus | null {
  const state = AppState.currentState
  return typeof state === 'string' && isAppStateStatus(state) ? state : null
}
