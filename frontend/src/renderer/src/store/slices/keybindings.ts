import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  KeybindingActionId,
  KeybindingFileSnapshot,
  KeybindingOverrides
} from '../../../../shared/keybindings'
import { getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { runtimeClientState } from '../../runtime/runtime-client-state-client'
import { enqueueWrite, withRetryAndErrorStatus } from '../backend-go-storage'

const EMPTY_KEYBINDINGS: KeybindingOverrides = {}

export type KeybindingsSlice = {
  keybindings: KeybindingOverrides
  keybindingSnapshot: KeybindingFileSnapshot | null
  fetchKeybindings: () => Promise<void>
  setKeybindingSnapshot: (snapshot: KeybindingFileSnapshot) => void
  ensureKeybindingsFile: () => Promise<KeybindingFileSnapshot | null>
  setKeybindingOverride: (actionId: KeybindingActionId, bindings: string[]) => Promise<void>
  resetKeybindingOverride: (actionId: KeybindingActionId) => Promise<void>
  disableKeybindingAction: (actionId: KeybindingActionId) => Promise<void>
  reloadKeybindings: () => Promise<void>
  openKeybindingsFile: () => Promise<void>
  revealKeybindingsFile: () => Promise<void>
}

function applySnapshot(
  snapshot: KeybindingFileSnapshot
): Pick<KeybindingsSlice, 'keybindings' | 'keybindingSnapshot'> {
  return {
    keybindings: snapshot.overrides,
    keybindingSnapshot: snapshot
  }
}

// Why: backend-go only stores the flat overrides map, not a keybindings.json
// file — there is no path/diagnostics/platform split to show, so
// keybindingSnapshot stays null. ShortcutsPane/hasCommonBindingOverride
// already tolerate a null snapshot (treated as "no common override").
function applyRemoteOverrides(
  overrides: KeybindingOverrides
): Pick<KeybindingsSlice, 'keybindings' | 'keybindingSnapshot'> {
  return {
    keybindings: overrides,
    keybindingSnapshot: null
  }
}

// FE-TASK-STORAGE-005: writes through backend-go-storage.ts's retry/queue
// helpers (withRetryAndErrorStatus + enqueueWrite — the same machinery a
// zustand `persist` StateStorage would use) directly, NOT via zustand's
// `persist` middleware itself.
//
// Why not `persist(...)` around this slice (FE-SOL-STORAGE-002 §4's literal
// shape): `persist` works by replacing the WHOLE STORE's `api.setState` with
// a wrapper that calls `storage.setItem` after every single `set()` call —
// not just calls made from within this slice's own actions. Since
// createKeybindingsSlice is one of ~40 slices spread into one combined
// `useAppStore` (store/index.ts), that wrapper would fire a 'keybindings'
// backend-go write on every unrelated state change anywhere in the app
// (toggling a sidebar, loading repos, ...) — including on desktop-local,
// where CR-STORAGE-001 requires zero clientState RPC traffic. Confirmed via
// a real regression: wrapping this slice in `persist` made unrelated store
// tests across the app throw/attempt backend-go RPCs. Calling the retry/queue
// helpers directly from just this slice's own remote-branch actions keeps
// the safety property (only *this* slice's writes ever reach backend-go) and
// still delivers CR-STORAGE-002's retry + visible-error-status contract.
function persistKeybindingsToBackendGo(next: KeybindingOverrides): void {
  void enqueueWrite('keybindings', () =>
    withRetryAndErrorStatus('keybindings', () => runtimeClientState.set('keybindings', next))
  )
}

// Why: setKeybindingOverride/resetKeybindingOverride/disableKeybindingAction
// all differ from each other only in what `bindings` means (a real array, or
// null/[] to reset/disable) — share the remote-branch mutation + backend-go
// write once instead of tripling the call sites.
function setRemoteKeybindingOverride(
  get: () => AppState,
  set: Parameters<StateCreator<AppState, [], [], KeybindingsSlice>>[0],
  actionId: KeybindingActionId,
  bindings: string[] | null
): void {
  const current = get().keybindings
  let next: KeybindingOverrides
  if (bindings === null) {
    const { [actionId]: _removed, ...rest } = current
    void _removed
    next = rest
  } else {
    next = { ...current, [actionId]: bindings }
  }
  set(applyRemoteOverrides(next))
  persistKeybindingsToBackendGo(next)
}

export const createKeybindingsSlice: StateCreator<AppState, [], [], KeybindingsSlice> = (
  set,
  get
) => ({
  keybindings: EMPTY_KEYBINDINGS,
  keybindingSnapshot: null,

  setKeybindingSnapshot: (snapshot) => set(applySnapshot(snapshot)),

  ensureKeybindingsFile: async () => {
    if (!window.api.keybindings) {
      return null
    }
    try {
      const snapshot = await window.api.keybindings.ensureFile()
      set(applySnapshot(snapshot))
      return snapshot
    } catch (error) {
      console.error('Failed to prepare keybindings file:', error)
      throw error
    }
  },

  fetchKeybindings: async () => {
    const target = getActiveRuntimeTarget(get().settings)
    if (target.kind !== 'environment') {
      if (!window.api.keybindings) {
        return
      }
      try {
        const snapshot = await window.api.keybindings.get()
        set(applySnapshot(snapshot))
      } catch (error) {
        console.error('Failed to fetch keybindings:', error)
      }
      return
    }
    // Web/paired: keybindings live in backend-go, not a local keybindings.json.
    try {
      const remote = await runtimeClientState.get<KeybindingOverrides>('keybindings')
      if (remote !== null) {
        set(applyRemoteOverrides(remote))
        return
      }
      // Why: no backend-go record yet — seed it once from this desktop's
      // local file so pairing with a runtime doesn't silently reset shortcuts
      // the user already customized.
      if (!window.api.keybindings) {
        set(applyRemoteOverrides(EMPTY_KEYBINDINGS))
        return
      }
      const localSnapshot = await window.api.keybindings.get()
      set(applyRemoteOverrides(localSnapshot.overrides))
      persistKeybindingsToBackendGo(localSnapshot.overrides)
    } catch (error) {
      console.error('Failed to fetch keybindings from backend-go:', error)
    }
  },

  setKeybindingOverride: async (actionId, bindings) => {
    const target = getActiveRuntimeTarget(get().settings)
    if (target.kind !== 'environment') {
      try {
        const snapshot = await window.api.keybindings.setAction({ actionId, bindings })
        set(applySnapshot(snapshot))
      } catch (error) {
        console.error('Failed to update keybinding:', error)
        throw error
      }
      return
    }
    setRemoteKeybindingOverride(get, set, actionId, bindings)
  },

  resetKeybindingOverride: async (actionId) => {
    const target = getActiveRuntimeTarget(get().settings)
    if (target.kind !== 'environment') {
      try {
        const snapshot = await window.api.keybindings.setAction({ actionId, bindings: null })
        set(applySnapshot(snapshot))
      } catch (error) {
        console.error('Failed to reset keybinding:', error)
        throw error
      }
      return
    }
    setRemoteKeybindingOverride(get, set, actionId, null)
  },

  disableKeybindingAction: async (actionId) => {
    const target = getActiveRuntimeTarget(get().settings)
    if (target.kind !== 'environment') {
      try {
        const snapshot = await window.api.keybindings.setAction({ actionId, bindings: [] })
        set(applySnapshot(snapshot))
      } catch (error) {
        console.error('Failed to disable keybinding:', error)
        throw error
      }
      return
    }
    setRemoteKeybindingOverride(get, set, actionId, [])
  },

  reloadKeybindings: async () => {
    if (!window.api.keybindings) {
      return
    }
    try {
      const snapshot = await window.api.keybindings.reload()
      set(applySnapshot(snapshot))
    } catch (error) {
      console.error('Failed to reload keybindings:', error)
    }
  },

  openKeybindingsFile: async () => {
    if (!window.api.keybindings) {
      return
    }
    try {
      const snapshot = await window.api.keybindings.openFile()
      set(applySnapshot(snapshot))
    } catch (error) {
      console.error('Failed to open keybindings file:', error)
    }
  },

  revealKeybindingsFile: async () => {
    if (!window.api.keybindings) {
      return
    }
    try {
      const snapshot = await window.api.keybindings.revealFile()
      set(applySnapshot(snapshot))
    } catch (error) {
      console.error('Failed to reveal keybindings file:', error)
    }
  }
})
