import type { GlobalSettings } from '../shared/types'
import { listEnvironments } from '../shared/runtime-environment-store'
import {
  isUserManagedRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../shared/runtime-environments'

type RuntimeEnvironmentFocusStore = {
  getSettings: () => Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  updateSettings: (
    updates: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>,
    options?: { notifyListeners?: boolean }
  ) => unknown
}

type SelfHealRuntimeEnvironmentFocusArgs = {
  store: RuntimeEnvironmentFocusStore
  userDataPath: string
  listKnownEnvironments?: (userDataPath: string) => KnownRuntimeEnvironment[]
  log?: (message: string) => void
}

function logClearedFocus(log: ((message: string) => void) | undefined, reason: string): void {
  const writeLog = log ?? console.info
  writeLog(`[runtime-environment-focus] cleared active runtime environment: ${reason}`)
}

export function clearActiveRuntimeEnvironmentFocusIfMatches(
  store: RuntimeEnvironmentFocusStore,
  environmentId: string
): void {
  if (store.getSettings().activeRuntimeEnvironmentId !== environmentId) {
    return
  }
  store.updateSettings({ activeRuntimeEnvironmentId: null }, { notifyListeners: true })
}

export function selfHealRuntimeEnvironmentFocus({
  store,
  userDataPath,
  listKnownEnvironments = listEnvironments,
  log
}: SelfHealRuntimeEnvironmentFocusArgs): void {
  const activeRuntimeEnvironmentId = store.getSettings().activeRuntimeEnvironmentId
  if (activeRuntimeEnvironmentId === undefined || activeRuntimeEnvironmentId === null) {
    return
  }

  if (activeRuntimeEnvironmentId.trim() === '') {
    store.updateSettings({ activeRuntimeEnvironmentId: null })
    logClearedFocus(log, 'empty persisted id')
    return
  }

  let environments: KnownRuntimeEnvironment[]
  try {
    environments = listKnownEnvironments(userDataPath)
  } catch {
    // Why: an unreadable registry must not clear a possibly-valid focus; keep
    // it and let a later launch heal once the registry reads again.
    return
  }

  const focusedEnvironment = environments.find((entry) => entry.id === activeRuntimeEnvironmentId)
  if (focusedEnvironment && isUserManagedRuntimeEnvironment(focusedEnvironment)) {
    return
  }

  store.updateSettings({ activeRuntimeEnvironmentId: null })
  logClearedFocus(log, `dangling id ${activeRuntimeEnvironmentId}`)
}
