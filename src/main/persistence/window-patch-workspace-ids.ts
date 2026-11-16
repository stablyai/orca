// Each workspace's ids the layout Loader resolves across a whole partition (row homes, reminted leaves, PTY owners, closed tabs).

import { collectLayoutLeafIdsInOrder } from '../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'

export type Json = Record<string, unknown>

export type WorkspaceIds = {
  tabs: Set<string>
  leaves: Set<string>
  ptys: Set<string>
  worktrees: Set<string>
}

const ID_KINDS = ['tabs', 'leaves', 'ptys', 'worktrees'] as const

/** Lists the Loader reads one workspace's records from. */
const WORKSPACE_RECORD_LISTS = [
  'tabsByWorktree',
  'unifiedTabs',
  'tabGroups',
  'openFilesByWorktree',
  'browserTabsByWorktree'
] as const

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asJson(value: unknown): Json {
  return isRecord(value) ? value : {}
}

export function fieldsOf(session: WorkspaceSessionState): Json {
  return session
}

export function field(session: WorkspaceSessionState, name: string): Json {
  return asJson(fieldsOf(session)[name])
}

/** The workspaces the Loader builds from this session. */
export function workspaceKeys(session: WorkspaceSessionState): Set<string> {
  const keys = new Set<string>()
  for (const name of [...WORKSPACE_RECORD_LISTS, 'tabGroupLayouts']) {
    for (const key of Object.keys(field(session, name))) {
      keys.add(key)
    }
  }
  return keys
}

function addStrings(into: Set<string>, values: readonly unknown[]): void {
  for (const value of values) {
    if (typeof value === 'string') {
      into.add(value)
    }
  }
}

export function emptyWorkspaceIds(): WorkspaceIds {
  return { tabs: new Set(), leaves: new Set(), ptys: new Set(), worktrees: new Set() }
}

/** Each workspace's tab, leaf, PTY and worktree ids, read from every given session. */
export function idsByWorkspace(
  sessions: readonly WorkspaceSessionState[]
): Map<string, WorkspaceIds> {
  const result = new Map<string, WorkspaceIds>()
  const idsOf = (key: string): WorkspaceIds => {
    let ids = result.get(key)
    if (!ids) {
      ids = emptyWorkspaceIds()
      ids.worktrees.add(key)
      result.set(key, ids)
    }
    return ids
  }
  for (const session of sessions) {
    for (const name of WORKSPACE_RECORD_LISTS) {
      for (const [key, list] of Object.entries(field(session, name))) {
        const ids = idsOf(key)
        for (const record of Array.isArray(list) ? list.filter(isRecord) : []) {
          addStrings(ids.tabs, [record.id, record.entityId])
          addStrings(ids.tabs, Array.isArray(record.tabOrder) ? record.tabOrder : [])
          addStrings(ids.ptys, [record.ptyId])
          addStrings(ids.worktrees, [record.worktreeId])
        }
      }
    }
    Object.keys(field(session, 'tabGroupLayouts')).forEach(idsOf)
  }
  for (const session of sessions) {
    for (const ids of result.values()) {
      for (const tabId of ids.tabs) {
        const layout = session.terminalLayoutsByTabId?.[tabId]
        addStrings(ids.leaves, collectLayoutLeafIdsInOrder(layout?.root))
        addStrings(ids.ptys, Object.values(layout?.ptyIdsByLeafId ?? {}))
      }
    }
  }
  return result
}

export function addWorkspaceIds(into: WorkspaceIds, from: WorkspaceIds | undefined): void {
  for (const kind of ID_KINDS) {
    from?.[kind].forEach((id) => into[kind].add(id))
  }
}

export function sharesWorkspaceIds(left: WorkspaceIds, right: WorkspaceIds): boolean {
  return ID_KINDS.some((kind) => {
    for (const value of left[kind]) {
      if (right[kind].has(value)) {
        return true
      }
    }
    return false
  })
}
