import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { PersistedUIState } from '../../shared/orca-profiles/persisted-ui-state-types'
import type { Store } from '../persistence/loading-store/store'

/** Writes main's native code asks the core to make. */
export type CoreWriteRequest =
  | { kind: 'ui'; updates: Partial<PersistedUIState> }
  /** Best effort: saves what is pending and swallows failures. */
  | { kind: 'flush-pending' }

/** Main's native code reads settings and UI state through this, never through the Store. */
export type NativeSettingsProjection = {
  getSettings(): Readonly<GlobalSettings>
  getUI(): Readonly<PersistedUIState>
  onSettingsChanged(
    listener: (
      updates: Readonly<Partial<GlobalSettings>>,
      settings: Readonly<GlobalSettings>
    ) => void
  ): () => void
  onUIChanged(listener: (ui: Readonly<PersistedUIState>) => void): () => void
  /** A UI write is visible to `getUI()` when this returns; the promise reports acceptance, not durability. */
  requestCoreWrite(request: CoreWriteRequest): Promise<void>
}

/** Backed by the in-process Store, so reads and accepted writes stay synchronous as before. */
export function createStoreNativeSettingsProjection(store: Store): NativeSettingsProjection {
  return {
    getSettings: () => store.getSettings(),
    getUI: () => store.getUI(),
    onSettingsChanged: (listener) => store.onSettingsChanged(listener),
    onUIChanged: (listener) => store.onUIChanged(listener),
    requestCoreWrite: (request) => {
      switch (request.kind) {
        case 'ui':
          store.updateUI(request.updates)
          return Promise.resolve()
        case 'flush-pending':
          return store.flushPendingAsync()
      }
    }
  }
}
