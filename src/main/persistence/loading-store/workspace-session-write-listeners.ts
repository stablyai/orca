import type { ExecutionHostId } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { StoreRuntimeState } from './store-runtime-state'
import { refileEditorViews } from './layout-editor-views'
import { sessionPublication } from './session-publication'
import type { SessionChangeSet } from '../../../shared/session-change-set'

/** Null means any partition may have changed. */
export type WorkspaceSessionWriteListener = (
  hostId: ExecutionHostId | null,
  changes?: readonly SessionChangeSet[]
) => void

/** Null means any partition may have changed. */
export type WorkspaceSessionOperationListener = (hostIds: readonly ExecutionHostId[] | null) => void

const WORKSPACE_SESSION_DOMAINS: readonly string[] = [
  'workspaceSession',
  'workspaceSessionsByHostId'
]

/** Full saves may contain untracked session edits; an absent host makes all partitions candidates. */
export function notifyWorkspaceSessionWritten(
  runtime: Pick<
    StoreRuntimeState,
    'workspaceSessionWriteListeners' | 'layoutEditorViews' | 'state'
  >,
  dirtyDomains?: readonly string[],
  hostId?: ExecutionHostId,
  unchangedOperation = false
): void {
  if (dirtyDomains && !dirtyDomains.some((domain) => WORKSPACE_SESSION_DOMAINS.includes(domain))) {
    return
  }
  const publication = sessionPublication(runtime.state)
  const pending = publication.take(hostId)
  const events: (SessionChangeSet | undefined)[] = pending.length
    ? pending
    : [
        unchangedOperation
          ? {
              hostId: hostId ?? 'local',
              kind: 'authoritative',
              generation: publication.partition(hostId ?? 'local').generation,
              fullReplacement: false,
              units: [],
              owners: new Set(),
              tabs: new Set(),
              panes: new Set(),
              files: new Set(),
              pages: new Set(),
              repos: new Set()
            }
          : undefined
      ]
  for (const event of events) {
    refileEditorViews(runtime, event)
  }
  const notifications = ORCA_LAYOUT_OWNER_IS_MAIN
    ? events.map((event) => ({
        host: hostId ?? event?.hostId ?? null,
        changes: event ? [event] : undefined
      }))
    : [
        {
          host: hostId ?? null,
          changes: pending.length ? pending : events[0] ? [events[0]] : undefined
        }
      ]
  for (const notification of notifications) {
    for (const listener of runtime.workspaceSessionWriteListeners) {
      try {
        listener(notification.host, notification.changes)
      } catch (error) {
        console.warn('[persistence] workspace-session write listener failed:', error)
      }
    }
  }
}

/** Main-owned layouts report each declared partition before announcing mutation completion. */
export function notifyWorkspaceSessionOperationEnded(
  runtime: Pick<
    StoreRuntimeState,
    | 'workspaceSessionWriteListeners'
    | 'workspaceSessionOperationListeners'
    | 'layoutEditorViews'
    | 'state'
  >,
  hostIds: readonly ExecutionHostId[] | null
): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    notifyWorkspaceSessionWritten(runtime, undefined, undefined, true)
    return
  }
  if (hostIds === null) {
    notifyWorkspaceSessionWritten(runtime, undefined, undefined, true)
  }
  for (const hostId of hostIds ?? []) {
    notifyWorkspaceSessionWritten(runtime, undefined, hostId, true)
  }
  for (const listener of runtime.workspaceSessionOperationListeners) {
    // Committed writes must survive a failed observer and still notify the remaining observers.
    try {
      listener(hostIds)
    } catch (error) {
      console.warn('[persistence] workspace-session operation listener failed:', error)
    }
  }
}
