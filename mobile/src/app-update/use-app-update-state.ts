import { useSyncExternalStore } from 'react'
import type { AppUpdateState } from './app-update-checker'
import { appUpdateChecker } from './app-update-runtime'

export function useAppUpdateState(): AppUpdateState {
  return useSyncExternalStore(appUpdateChecker.subscribe, appUpdateChecker.getSnapshot)
}
