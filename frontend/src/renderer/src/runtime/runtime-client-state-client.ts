// FE-TASK-STORAGE-001/006/009: thin, kind-parameterized RPC client for
// backend-go's clientState.get/clientState.set (BE-SOL-STORAGE-001's
// ClientStateKind enum → client_settings_json-style columns). One shared
// module, not one wrapper per kind, because the operation is identical
// (get/set one opaque JSON blob) and only `kind` + the TypeScript generic
// differ — mirrors the backend's own single enum-parameterized RPC pair.
import type { GlobalSettings } from '../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'

export type ClientStateKind =
  | 'keybindings'
  | 'uiLocal'
  | 'savedRuntimeEnvironments'
  // FE-TASK-STORAGE-006: full GlobalSettings mirror, parallel to the legacy
  // 5-field settings.get/settings.update RPC (see web-preload-api.ts).
  | 'settings'
  // FE-TASK-STORAGE-009: environmentId -> devServerId picker preference map.
  | 'accountsDevServerMap'

type ClientStateSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
type ClientStateSettingsAccessor = () => ClientStateSettings

// Why: this module is imported by store/slices/keybindings.ts, which
// store/index.ts imports directly to build the aggregate store. A top-level
// `import { useAppStore } from '../store'` here would close that into a
// genuine circular module dependency at module-EVALUATION time — see
// dev-servers-selectors.ts's doc comment for the exact live bug this pattern
// caused elsewhere ("createDevServerSlice is not a function"). Instead,
// store/index.ts calls registerClientStateSettingsAccessor(...) once, after
// the store is fully constructed — same technique as
// registerHttpLinkStoreAccessor in lib/http-link-routing.ts.
let settingsAccessor: ClientStateSettingsAccessor = () => null

export function registerClientStateSettingsAccessor(accessor: ClientStateSettingsAccessor): void {
  settingsAccessor = accessor
}

type ClientStateGetResult = { found: boolean; stateJson?: string }

async function getClientState<T>(kind: ClientStateKind): Promise<T | null> {
  const target = getActiveRuntimeTarget(settingsAccessor())
  const result = await callRuntimeRpc<ClientStateGetResult>(target, 'clientState.get', { kind })
  if (!result.found || result.stateJson === undefined) {
    return null
  }
  return JSON.parse(result.stateJson) as T
}

async function setClientState<T>(kind: ClientStateKind, state: T): Promise<void> {
  const target = getActiveRuntimeTarget(settingsAccessor())
  await callRuntimeRpc(target, 'clientState.set', { kind, stateJson: JSON.stringify(state) })
}

export const runtimeClientState = { get: getClientState, set: setClientState }
