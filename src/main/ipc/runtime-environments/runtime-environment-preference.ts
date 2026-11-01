import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  getEnvironmentStorePath,
  listEnvironments
} from '../../../shared/runtime-environment-store'
import type { Store } from '../../persistence'
import { watchFileAcrossReplacement } from '../rebinding-file-watch'

type PreferenceStore = Pick<Store, 'getSettings' | 'updateSettings'>

function reconcileRuntimeEnvironmentPreference(
  store: PreferenceStore,
  environments: readonly { id: string }[]
): GlobalSettings {
  const settings = store.getSettings()
  const activeId = settings?.activeRuntimeEnvironmentId?.trim()
  if (!activeId || environments.some((environment) => environment.id === activeId)) {
    return settings
  }
  // A deleted default must not keep routing unrelated requests to its retired pairing.
  return store.updateSettings({ activeRuntimeEnvironmentId: null }, { notifyListeners: true })
}

export function readSettingsWithRuntimeEnvironmentPreference(
  store: PreferenceStore,
  userDataPath: string
): GlobalSettings {
  const settings = store.getSettings()
  if (!settings?.activeRuntimeEnvironmentId?.trim()) {
    return settings
  }
  let environments: { id: string }[]
  try {
    // An unavailable registry cannot prove the selected host was removed.
    environments = listEnvironments(userDataPath, { requireStoreFile: true })
  } catch {
    return settings
  }
  return reconcileRuntimeEnvironmentPreference(store, environments)
}

// Bound renderer staleness when the registry is created or replaced without a native watch event.
const REGISTRY_REBIND_SWEEP_MS = 30_000

export function watchRuntimeEnvironmentPreference(
  store: PreferenceStore,
  userDataPath: string,
  // Renderers cache the catalog; CLI edits reach them only through this watch.
  onRegistryChanged: () => void = () => {}
): () => void {
  const repairPreference = (): void => {
    try {
      readSettingsWithRuntimeEnvironmentPreference(store, userDataPath)
    } catch (error) {
      console.warn('[runtime-environments] Active Server preference repair failed:', error)
    }
  }
  // Reconcile changes made while the native watch was being installed.
  const initialCheck = setImmediate(repairPreference)
  // Watch the file: macOS directory watches recursively stream Orca's own userData writes.
  const registryWatch = watchFileAcrossReplacement(
    getEnvironmentStorePath(userDataPath),
    () => {
      repairPreference()
      onRegistryChanged()
    },
    (error) => console.warn('[runtime-environments] Active Server preference watch failed:', error)
  )
  const sweep = setInterval(() => void registryWatch.refresh(), REGISTRY_REBIND_SWEEP_MS)
  sweep.unref?.()
  return () => {
    clearImmediate(initialCheck)
    clearInterval(sweep)
    void registryWatch.close()
  }
}
