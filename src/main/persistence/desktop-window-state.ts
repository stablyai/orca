import type { WebContents } from 'electron'
import type { Store } from '../persistence'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import {
  DESKTOP_WINDOW_UI_FIELDS,
  type PersistedDesktopWindowState
} from '../../shared/desktop-window-state-types'
import { LOCAL_EXECUTION_HOST_ID, normalizeExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  omitStoredFields,
  pickStoredFields
} from '../../shared/workspace-layout/stored-record-fields'
import { loadWorkspaceLayoutWithoutReport } from '../../shared/workspace-layout/workspace-layout-load'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import { desktopWindowId } from '../window/desktop-renderer-registry'
import { patchStoredSession } from '../../shared/workspace-layout/workspace-layout-record-patch'

type WindowStateStore = Pick<Store, 'getUI' | 'updateUI'>

export function updateDesktopWindowState(
  store: WindowStateStore,
  windowId: string,
  patch: Partial<PersistedDesktopWindowState>
): void {
  const windows = store.getUI().desktopWindows ?? {}
  store.updateUI({
    desktopWindows: {
      ...windows,
      [windowId]: {
        ...windows[windowId],
        ...patch,
        open: patch.open ?? windows[windowId]?.open ?? true
      }
    }
  })
}

export function saveDesktopWindowGeometry(
  store: WindowStateStore,
  windowId: string | undefined,
  updates: Pick<Partial<PersistedUIState>, 'windowBounds' | 'windowMaximized'>
): void {
  if (!windowId) {
    store.updateUI(updates)
    return
  }
  updateDesktopWindowState(store, windowId, {
    ...(updates.windowBounds !== undefined ? { bounds: updates.windowBounds ?? undefined } : {}),
    ...(updates.windowMaximized !== undefined ? { maximized: updates.windowMaximized } : {})
  })
}

export function desktopWindowUI(ui: PersistedUIState, renderer?: WebContents): PersistedUIState {
  const id = desktopWindowId(renderer)
  const state = id ? ui.desktopWindows?.[id] : undefined
  const shared = omitStoredFields(ui, ['desktopWindows'])
  return state
    ? {
        ...shared,
        ...state.ui,
        windowBounds: state.bounds ?? ui.windowBounds,
        windowMaximized: state.maximized ?? ui.windowMaximized
      }
    : shared
}

export function updateDesktopWindowUI(
  store: WindowStateStore,
  renderer: WebContents | undefined,
  updates: Partial<PersistedUIState>
): void {
  const writable = omitStoredFields(updates, ['desktopWindows'])
  const id = desktopWindowId(renderer)
  if (!id) {
    store.updateUI(writable)
    return
  }
  const current = store.getUI().desktopWindows ?? {}
  const local = pickStoredFields(writable, DESKTOP_WINDOW_UI_FIELDS)
  const shared = omitStoredFields(writable, DESKTOP_WINDOW_UI_FIELDS)
  store.updateUI({
    ...shared,
    desktopWindows: {
      ...current,
      [id]: {
        ...current[id],
        open: current[id]?.open ?? true,
        ui: { ...current[id]?.ui, ...local }
      }
    }
  })
}

export function desktopWindowSession(
  store: Pick<Store, 'getUI' | 'getWorkspaceSession'>,
  renderer: WebContents | undefined,
  hostId?: string | null
): WorkspaceSessionState {
  const session = store.getWorkspaceSession(hostId)
  const id = desktopWindowId(renderer)
  const host = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  const view = id ? store.getUI().desktopWindows?.[id]?.viewsByHostId?.[host] : undefined
  if (!view) {
    return session
  }
  const loaded = loadWorkspaceLayoutWithoutReport(host, session, nameBasedLoadContext())
  return patchStoredSession(
    session,
    saveWorkspaceLayout(loaded),
    saveWorkspaceLayout({ ...loaded, desktopView: { ...loaded.desktopView, ...view } })
  )
}

export function saveDesktopWindowSessionView(
  store: WindowStateStore,
  renderer: WebContents | undefined,
  session: WorkspaceSessionState,
  hostId?: string | null
): void {
  const id = desktopWindowId(renderer)
  if (!id) {
    return
  }
  const host = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  const { desktopView } = loadWorkspaceLayoutWithoutReport(host, session, nameBasedLoadContext())
  const current = store.getUI().desktopWindows?.[id]
  updateDesktopWindowState(store, id, {
    viewsByHostId: { ...current?.viewsByHostId, [host]: desktopView }
  })
}
