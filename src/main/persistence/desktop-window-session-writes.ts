import type { WebContents } from 'electron'
import type { Store } from '../persistence'
import { LOCAL_EXECUTION_HOST_ID, normalizeExecutionHostId } from '../../shared/execution-host'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import { patchStoredSession } from '../../shared/workspace-layout/workspace-layout-record-patch'
import { desktopWindowId } from '../window/desktop-renderer-registry'
import { desktopWindowSession } from './desktop-window-state'
import { preserveConcurrentTabGroupOrder } from '../../shared/desktop-window-tab-order'

const savedViews = new WeakMap<WebContents, Map<string, WorkspaceSessionState>>()

type SessionStore = Pick<Store, 'getUI' | 'getWorkspaceSession'>

export function readDesktopWindowSession(
  store: SessionStore,
  renderer: WebContents | undefined,
  hostId?: string | null
): WorkspaceSessionState {
  const session = desktopWindowSession(store, renderer, hostId)
  if (renderer && desktopWindowId(renderer)) {
    const host = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
    const views = savedViews.get(renderer) ?? new Map<string, WorkspaceSessionState>()
    views.set(host, structuredClone(session))
    savedViews.set(renderer, views)
  }
  return session
}

export function prepareDesktopWindowSessionWrite(
  store: SessionStore,
  renderer: WebContents | undefined,
  write:
    | { kind: 'set'; session: WorkspaceSessionState }
    | { kind: 'patch'; patch: WorkspaceSessionPatch },
  hostId?: string | null
): {
  window: WorkspaceSessionState
  shared: WorkspaceSessionState
  commit: () => void
} | null {
  if (!renderer || !desktopWindowId(renderer)) {
    return null
  }
  const host = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  const views = savedViews.get(renderer) ?? new Map<string, WorkspaceSessionState>()
  const baseline = views.get(host) ?? desktopWindowSession(store, renderer, host)
  const window = write.kind === 'set' ? write.session : { ...baseline, ...write.patch }
  const stored = store.getWorkspaceSession(host)
  const shared = preserveConcurrentTabGroupOrder(
    stored,
    baseline,
    window,
    patchStoredSession(stored, baseline, window)
  )
  const nextBaseline = structuredClone(window)
  return {
    window,
    shared,
    commit: () => {
      views.set(host, nextBaseline)
      savedViews.set(renderer, views)
    }
  }
}
