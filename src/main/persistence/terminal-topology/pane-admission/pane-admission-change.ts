// Write a pane admission's change back: a sliced load patches key by key, a whole load keeps its build's write.

import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { LoadedWorkspaceLayout } from '../../../../shared/workspace-layout/persistence/workspace-layout-load-types'
import { patchStoredSession } from '../../../../shared/workspace-layout/persistence/workspace-layout-record-patch'
import { WORKSPACE_FIELDS } from '../../../../shared/workspace-layout/persistence/workspace-layout-load-slice'
import { stableJson } from '../../../../shared/workspace-layout/persistence/workspace-layout-load-report'
import { saveWorkspaceLayout } from '../../../../shared/workspace-layout/persistence/workspace-layout-save'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { loadPaneCommandLayout, type PaneCommandIds } from './pane-admission-slice-load'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A slice saves only its own records, so a map it first fills or empties patches key by key; replacing or dropping it would lose other workspaces' entries. */
export function patchSlicedSession(
  stored: WorkspaceSessionState,
  before: WorkspaceSessionState,
  after: WorkspaceSessionState
): WorkspaceSessionState {
  const sides: [Record<string, unknown>, Record<string, unknown>] = [{ ...before }, { ...after }]
  const emptied: string[] = []
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const [was, is] = [sides[0][field], sides[1][field]]
    if ((was === undefined && isRecord(is)) || (isRecord(was) && is === undefined)) {
      sides[0][field] ??= {}
      sides[1][field] ??= {}
      if (is === undefined) {
        emptied.push(field)
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: copies of saved sessions with absent maps made empty.
  const [from, to] = sides as unknown as [WorkspaceSessionState, WorkspaceSessionState]
  const workspaces = [
    ...new Set([...Object.keys(from.tabsByWorktree ?? {}), ...Object.keys(to.tabsByWorktree ?? {})])
  ]
  const patched = withoutHiddenCopies(
    patchStoredSession(stored, from, to, undefined, workspaces),
    from,
    to,
    workspaces
  )
  // The whole save drops an emptied map only once no workspace holds an entry.
  const fields: Record<string, unknown> = patched
  const dropped = emptied.filter((field) => {
    const map = fields[field]
    return isRecord(map) && Object.keys(map).length === 0
  })
  if (dropped.length === 0) {
    return patched
  }
  const trimmed: Record<string, unknown> = { ...patched }
  dropped.forEach((field) => delete trimmed[field])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the patched session minus empty maps.
  return trimmed as unknown as WorkspaceSessionState
}

const rowIds = (session: WorkspaceSessionState): Set<string> =>
  new Set(Object.values(session.tabsByWorktree ?? {}).flatMap((rows) => rows.map((row) => row.id)))

/** Window-owned builds rewrote the partition, which also dropped copies of a removed row the Loader had hidden in other workspaces; a kept copy would bring the row back on the next load. */
function withoutHiddenCopies(
  patched: WorkspaceSessionState,
  before: WorkspaceSessionState,
  after: WorkspaceSessionState,
  workspaces: readonly string[]
): WorkspaceSessionState {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    return patched
  }
  const kept = rowIds(after)
  const removed = [...rowIds(before)].filter((id) => !kept.has(id))
  if (removed.length === 0) {
    return patched
  }
  let tabsByWorktree = patched.tabsByWorktree
  for (const key of workspaces) {
    const rows = tabsByWorktree[key] ?? []
    const visible = new Set((before.tabsByWorktree?.[key] ?? []).map((row) => row.id))
    const left = rows.filter((row) => visible.has(row.id) || !removed.includes(row.id))
    if (left.length !== rows.length) {
      tabsByWorktree = { ...tabsByWorktree, [key]: left }
    }
  }
  return tabsByWorktree === patched.tabsByWorktree ? patched : { ...patched, tabsByWorktree }
}

/** Records a slice loads whole by key: its workspaces' maps and its rows' and panes' records. */
const SLICE_OWNED_FIELDS = [
  ...WORKSPACE_FIELDS,
  'terminalLayoutsByTabId',
  'remoteSessionIdsByTabId',
  'sleepingAgentSessionsByPaneKey',
  'terminalPtyIncarnationsByPaneKey',
  'closedTerminalTabTombstonesByTabId'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

/** Window-owned builds rewrote the partition from the load; a slice rewrites the records it loaded the same way, so legacy duplicates the Loader drops go too, and keeps the rest as stored. */
function rewriteSlice(
  stored: WorkspaceSessionState,
  slice: WorkspaceSessionState,
  before: WorkspaceSessionState,
  after: WorkspaceSessionState
): WorkspaceSessionState {
  const patched = patchSlicedSession(stored, before, after)
  let next: Record<string, unknown> | null = null
  for (const field of SLICE_OWNED_FIELDS) {
    const saved: Record<string, unknown> | undefined = after[field]
    const kept: Record<string, unknown> | undefined = patched[field]
    const keys = new Set([...Object.keys(slice[field] ?? {}), ...Object.keys(saved ?? {})])
    let map: Record<string, unknown> | null = null
    for (const key of keys) {
      const value = saved?.[key]
      if (stableJson(value) !== stableJson(kept?.[key])) {
        map ??= { ...kept }
        if (value === undefined) {
          delete map[key]
        } else {
          map[key] = value
        }
      }
    }
    if (map) {
      next ??= { ...patched }
      if (Object.keys(map).length === 0 && saved === undefined) {
        delete next[field]
      } else {
        next[field] = map
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the patched session with the slice's own records rewritten from its save.
  return next ? (next as unknown as WorkspaceSessionState) : patched
}

/**
 * Each build keeps its own write, narrowed to the slice: window-owned builds rewrite what they loaded,
 * main-owned builds patch only what the command changed so Loader normalizations stay unwritten
 * (workspace-layout-record-patch.ts).
 */
export function loadPaneChange(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  ids: PaneCommandIds
): {
  loaded: LoadedWorkspaceLayout
  write?: (after: WorkspaceSessionState) => WorkspaceSessionState | null
} {
  const { loaded, slice } = loadPaneCommandLayout(hostId, session, ids)
  if (!slice && !ORCA_LAYOUT_OWNER_IS_MAIN) {
    return { loaded }
  }
  return {
    loaded,
    write: (after) => {
      const before = saveWorkspaceLayout(loaded)
      const patched = !slice
        ? patchStoredSession(session, before, after)
        : ORCA_LAYOUT_OWNER_IS_MAIN
          ? patchSlicedSession(session, before, after)
          : withoutHiddenCopies(rewriteSlice(session, slice, before, after), before, after, [
              ...new Set([
                ...Object.keys(before.tabsByWorktree),
                ...Object.keys(after.tabsByWorktree)
              ])
            ])
      return patched === session ? null : patched
    }
  }
}
