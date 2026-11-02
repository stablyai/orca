// Model profile sessions by host, including routed layout commands and write notifications.
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { LayoutCommand } from '../../shared/workspace-layout/workspace-layout-command-types'
import { resolveHostId } from '../persistence/loading-store/session-host-partitions'
import { applyCommandToSession } from '../persistence/terminal-topology/terminal-pane-admission'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeStore } from './runtime-store-contract'

export type SessionStore = {
  getWorkspaceSession?: (hostId?: string) => WorkspaceSessionState | null | undefined
  setWorkspaceSession?: (session: WorkspaceSessionState, hostId?: string) => void
  getWorkspaceSessionHostIds?: () => readonly string[]
  applyLayoutCommand?: (command: LayoutCommand, hostIds?: readonly string[]) => Promise<unknown>
} & Pick<RuntimeStore, 'onWorkspaceSessionWritten'>

type WriteListener = Parameters<NonNullable<RuntimeStore['onWorkspaceSessionWritten']>>[0]

// The partitions a store without its own host list has had panes bound in.
const boundHostIdsByStore = new WeakMap<SessionStore, Set<string>>()

const installedSessionStores = new WeakSet<SessionStore>()
const installedLayoutApplies = new WeakSet<SessionStore>()
const writeListenersByStore = new WeakMap<SessionStore, Set<WriteListener>>()

/** Install before first graph subscription; direct and layout-command writes must notify main's post-commit merge. */
export function announceSessionWrites(store: SessionStore & Pick<RuntimeStore, 'getRepos'>): void {
  if (store.onWorkspaceSessionWritten) {
    return
  }
  const listeners = new Set<WriteListener>()
  writeListenersByStore.set(store, listeners)
  const subscribe: SessionStore['onWorkspaceSessionWritten'] = (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  // Keep subscription non-enumerable so spread copies do not inherit another store's write listeners.
  Object.defineProperty(store, 'onWorkspaceSessionWritten', {
    value: subscribe,
    configurable: true,
    writable: true,
    enumerable: false
  })
}

function announceWrite(store: SessionStore, hostId: string | undefined): void {
  for (const listener of writeListenersByStore.get(store) ?? []) {
    listener(resolveHostId(hostId))
  }
}

/** Drops the in-memory session bindPaneFirst gave a store shared across tests, so none leaks. */
export function forgetInstalledPaneSession(
  store: SessionStore & Pick<RuntimeStore, 'getRepos'>
): void {
  if (installedLayoutApplies.delete(store)) {
    delete store.applyLayoutCommand
  }
  if (writeListenersByStore.delete(store)) {
    delete store.onWorkspaceSessionWritten
  }
  if (!installedSessionStores.delete(store)) {
    return
  }
  delete store.getWorkspaceSession
  delete store.setWorkspaceSession
  if (boundHostIdsByStore.delete(store)) {
    delete store.getWorkspaceSessionHostIds
  }
}

export function storeOf(runtime: OrcaRuntimeService): SessionStore | null {
  return runtime['store'] ?? null
}

/** Supply missing profile session APIs, track host partitions, and retain state for fixture cleanup. */
export function asProfileSessionStore(
  store: SessionStore,
  hostId: string
): {
  get: (host: string) => WorkspaceSessionState
  set: (session: WorkspaceSessionState, host: string) => void
} {
  if (!store.getWorkspaceSession || !store.setWorkspaceSession) {
    installedSessionStores.add(store)
    const sessions = new Map<string, WorkspaceSessionState>()
    store.getWorkspaceSession = (host = 'local') =>
      sessions.get(host) ?? getDefaultWorkspaceSession()
    store.setWorkspaceSession = (next, host = 'local') => {
      sessions.set(host, next)
      announceWrite(store, host)
    }
  }
  if (!store.getWorkspaceSessionHostIds) {
    const hostIds = new Set<string>()
    boundHostIdsByStore.set(store, hostIds)
    store.getWorkspaceSessionHostIds = () => [...hostIds]
  }
  const { getWorkspaceSession, setWorkspaceSession } = store
  if (!store.applyLayoutCommand) {
    installedLayoutApplies.add(store)
    store.applyLayoutCommand = async (command, hostIds = []) => {
      const host = resolveHostId(hostIds[0])
      const change = applyCommandToSession(
        host,
        getWorkspaceSession(host) ?? getDefaultWorkspaceSession(),
        command
      )
      if (change.session) {
        setWorkspaceSession(change.session, host)
      }
      return change.value
    }
  }
  boundHostIdsByStore.get(store)?.add(hostId)
  return {
    get: (host) => getWorkspaceSession(host) ?? getDefaultWorkspaceSession(),
    set: (session, host) => setWorkspaceSession(session, host)
  }
}

/** The session main's layout reads from the runtime's store, as bindPaneFirst left it. */
export function boundSessionOf(
  runtime: OrcaRuntimeService,
  hostId = 'local'
): WorkspaceSessionState {
  return storeOf(runtime)?.getWorkspaceSession?.(hostId) ?? getDefaultWorkspaceSession()
}
