// Load only the workspaces a pane admission or withdrawal can read: its own, those holding an id it names, and every workspace the Loader ties to them.

import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ReverseIndexedMap } from '../../../../shared/collections/reverse-indexed-map'
import {
  loadWorkspaceLayoutWithoutReport,
  workspaceKeys
} from '../../../../shared/workspace-layout/persistence/workspace-layout-load'
import { resolveWorktreeId } from '../../../../shared/workspace-layout/persistence/workspace-layout-load-records'
import {
  leafShareRef,
  loadedShareRefs,
  rowShareRef,
  sliceWorkspaceSession,
  storedShareRefs,
  worktreeShareRef
} from '../../../../shared/workspace-layout/persistence/workspace-layout-load-slice'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/persistence/workspace-layout-minted-ids'
import type {
  LoadedWorkspaceLayout,
  WorkspaceLayoutLoadContext
} from '../../../../shared/workspace-layout/persistence/workspace-layout-load-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

/** Past this many tied workspaces a whole load is as cheap and simpler to trust. */
const MAX_SLICED_WORKSPACES = 64

/** The workspace a pane command targets and the tab, pane and group ids it names. */
export type PaneCommandIds = {
  workspace: string
  tabId: string
  leafIds: readonly (string | undefined)[]
  groupId?: string
}

const tabShareRef = (tabId: string): string => `tab:${tabId}`
const groupShareRef = (groupId: string): string => `group:${groupId}`

/** Loader refs plus the tab and group ids commands check across workspaces. */
function workspaceRefs(session: WorkspaceSessionState, key: string): Set<string> | null {
  const stored = storedShareRefs(session, key)
  if (!stored) {
    return null
  }
  for (const tab of session.unifiedTabs?.[key] ?? []) {
    stored.refs.add(tabShareRef(tab.id))
    stored.refs.add(tabShareRef(tab.entityId))
  }
  for (const group of session.tabGroups?.[key] ?? []) {
    stored.refs.add(groupShareRef(group.id))
  }
  return stored.refs
}

function commandRefs(session: WorkspaceSessionState, ids: PaneCommandIds): string[] {
  const refs = [
    worktreeShareRef(resolveWorktreeId({ session, key: ids.workspace })),
    tabShareRef(ids.tabId),
    rowShareRef(ids.tabId),
    ...ids.leafIds.flatMap((leafId) => (leafId ? [leafShareRef(leafId)] : [])),
    ...(ids.groupId ? [groupShareRef(ids.groupId)] : [])
  ]
  // Main refuses to recreate a tab whose closed record sits in another workspace.
  const closed = session.closedTerminalTabTombstonesByTabId?.[ids.tabId]
  if (closed) {
    refs.push(worktreeShareRef(closed.worktreeId))
  }
  return refs
}

/** The sliced load, or null whenever only a whole-partition load is exact. */
export function loadPaneCommandSlice(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  ids: PaneCommandIds,
  context: WorkspaceLayoutLoadContext
): { loaded: LoadedWorkspaceLayout; slice: WorkspaceSessionState } | null {
  const legacy = session.terminalSurfaceTombstonesByPaneKey
  if (legacy && Object.keys(legacy).length > 0) {
    return null
  }
  const order = workspaceKeys(session)
  const refs = new ReverseIndexedMap<string, ReadonlySet<string>, string>((value) => value)
  for (const key of order) {
    const held = workspaceRefs(session, key)
    // A row saved before pane layouts takes its pane id from partition-wide records.
    if (!held) {
      return null
    }
    refs.set(key, held)
  }
  const tied = new Set<string>()
  const queue = commandRefs(session, ids)
  const seen = new Set(queue)
  const visit = (key: string): boolean => {
    if (tied.has(key)) {
      return true
    }
    if (tied.size === MAX_SLICED_WORKSPACES) {
      return false
    }
    tied.add(key)
    for (const ref of refs.get(key)!) {
      if (!seen.has(ref)) {
        seen.add(ref)
        queue.push(ref)
      }
    }
    return true
  }
  if (refs.has(ids.workspace) && !visit(ids.workspace)) {
    return null
  }
  for (let ref = queue.pop(); ref !== undefined; ref = queue.pop()) {
    for (const key of refs.keysFor(ref)) {
      if (!visit(key)) {
        return null
      }
    }
  }
  const keys = order.filter((key) => tied.has(key))
  const worktreeIds = new Set(
    [...seen].flatMap((ref) => (ref.startsWith('worktree:') ? [ref.slice('worktree:'.length)] : []))
  )
  const slice = sliceWorkspaceSession(session, keys, worktreeIds)
  const loaded = loadWorkspaceLayoutWithoutReport(hostId, slice, context)
  for (const key of keys) {
    const workspace = loaded.layout.workspaces[key]
    if (!workspace) {
      return null
    }
    // A reminted pane id or newly resolved worktree id can tie a workspace the slice left out.
    for (const ref of loadedShareRefs(workspace)) {
      for (const sharer of refs.keysFor(ref)) {
        if (!tied.has(sharer)) {
          return null
        }
      }
    }
  }
  return { loaded, slice }
}

/** The sliced load when exact, with the slice it loaded; else the whole partition's. */
export function loadPaneCommandLayout(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  ids: PaneCommandIds
): { loaded: LoadedWorkspaceLayout; slice?: WorkspaceSessionState } {
  return (
    loadPaneCommandSlice(hostId, session, ids, nameBasedLoadContext()) ?? {
      loaded: loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext())
    }
  )
}
