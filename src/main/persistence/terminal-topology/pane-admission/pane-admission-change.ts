// Write a pane admission's change back: a sliced load patches key by key, a whole load keeps its build's write.

import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { LoadedWorkspaceLayout } from '../../../../shared/workspace-layout/persistence/workspace-layout-load-types'
import { patchStoredSession } from '../../../../shared/workspace-layout/persistence/workspace-layout-record-patch'
import { saveWorkspaceLayout } from '../../../../shared/workspace-layout/persistence/workspace-layout-save'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { loadPaneCommandLayout, type PaneCommandIds } from './pane-admission-slice-load'
import { rewriteSliceRecords } from './pane-admission-slice-records'

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
  const patched = patchStoredSession(stored, from, to, undefined, workspaces)
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
          : rewriteSliceRecords(patchSlicedSession(session, before, after), slice, after)
      return patched === session ? null : patched
    }
  }
}
