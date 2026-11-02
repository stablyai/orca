// A window's session save in a layout-owner build: every tab and pane change reaches main as a
// layout command, so main keeps its own layout and takes from the save only what the window owns:
// its view (selection, focus, drafts), the facts its views report (titles, scrollback, page
// state) and the fields passed through untouched. A paired server's partition is the server's
// layout, mirrored by the window, and passes through as it is.

import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import { SESSION_FIELD_OWNERS } from '../../shared/workspace-layout/workspace-layout-beside'
import { loadWorkspaceLayoutWithoutReport } from '../../shared/workspace-layout/workspace-layout-load'
import type { LoadedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load-types'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceLayoutModel } from '../../shared/workspace-layout/workspace-layout-model'
import { patchStoredSession } from '../../shared/workspace-layout/workspace-layout-record-patch'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'

const FIELD_OWNERS: Readonly<Record<string, string>> = SESSION_FIELD_OWNERS

/** Fields main writes from its own layout; the Loader's one-time legacy field goes with them. */
function isLayoutField(field: string): boolean {
  const owner = Object.hasOwn(FIELD_OWNERS, field) ? FIELD_OWNERS[field] : undefined
  return owner === 'layout' || owner === 'legacy'
}

/**
 * A workspace main holds that the window visited keeps its terminal row, as the window's save
 * did: a relaunch then leaves a workspace emptied by a recorded close empty
 * (isTerminalWorkspaceEmptiedOnPurpose, admitsInitialSurface).
 */
function withVisitedRowOwners(
  layout: WorkspaceLayoutModel,
  visited: Readonly<Record<string, number>> | undefined
): WorkspaceLayoutModel {
  const added = Object.keys(visited ?? {}).filter(
    (key) => layout.workspaces[key] && !layout.legacy.terminalRowOwners[key]
  )
  if (added.length === 0) {
    return layout
  }
  const owners = { ...layout.legacy.terminalRowOwners }
  for (const key of added) {
    owners[key] = true
  }
  return { ...layout, legacy: { ...layout.legacy, terminalRowOwners: owners } }
}

/** Main's layout with the window's view, facts and carried fields, written as a session. */
function joinWindowView(
  main: LoadedWorkspaceLayout,
  windows: LoadedWorkspaceLayout
): WorkspaceSessionState {
  return saveWorkspaceLayout({
    layout: withVisitedRowOwners(main.layout, windows.desktopView.lastVisitedAtByWorktreeId),
    desktopView: windows.desktopView,
    facts: windows.facts,
    // What names no tab or workspace main holds is main's too.
    carried: {
      ...windows.carried,
      unownedTerminalLayouts: main.carried.unownedTerminalLayouts,
      unplacedSleepingRecords: main.carried.unplacedSleepingRecords,
      unplacedIncarnations: main.carried.unplacedIncarnations,
      unplacedClosedTabs: main.carried.unplacedClosedTabs
    }
  })
}

/**
 * The stored partition with the window's view and facts written into main's records. Only records
 * the join changes are rewritten, as a layout command writes, so untouched records stay as stored.
 */
function storedWithWindowView(
  partition: ExecutionHostId,
  stored: WorkspaceSessionState,
  window: WorkspaceSessionState
): WorkspaceSessionState {
  const context = nameBasedLoadContext()
  const main = loadWorkspaceLayoutWithoutReport(partition, stored, context)
  const windows = loadWorkspaceLayoutWithoutReport(partition, window, context)
  return patchStoredSession(stored, saveWorkspaceLayout(main), joinWindowView(main, windows))
}

/** The window's save with each named layout field taken from main's stored partition. */
function withMainLayoutFields<T extends WorkspaceSessionPatch>(
  save: T,
  joined: WorkspaceSessionState,
  fields: readonly string[]
): T {
  const mains: Readonly<Record<string, unknown>> = joined
  const result: Record<string, unknown> = { ...save }
  for (const field of fields) {
    result[field] = mains[field]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field is the save's own or main's stored session's, the same session type.
  return result as T
}

/**
 * A full save main applies in a layout-owner build (`session:set`, the shutdown stage): the
 * window's own fields as sent, and main's layout fields with the window's view and facts in them.
 */
export function windowViewSaveForMain(
  stored: WorkspaceSessionState,
  save: WorkspaceSessionState,
  hostId: string | null | undefined
): WorkspaceSessionState {
  const partition = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  if (parseExecutionHostId(partition)?.kind === 'runtime') {
    return save
  }
  const joined = storedWithWindowView(partition, stored, save)
  const fields = [...new Set([...Object.keys(save), ...Object.keys(joined)])]
  return withMainLayoutFields(save, joined, fields.filter(isLayoutField))
}

/**
 * A `session:patch` in a layout-owner build: its own fields as sent, and each layout field it
 * carries comes back as main's with the window's view and facts in it. A patch carrying none
 * skips the layout entirely, as today's scalar patch skips terminal normalization.
 */
export function windowViewPatchForMain(
  stored: WorkspaceSessionState,
  patch: WorkspaceSessionPatch,
  hostId: string | null | undefined
): WorkspaceSessionPatch {
  const partition = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  const fields = Object.keys(patch).filter(isLayoutField)
  if (parseExecutionHostId(partition)?.kind === 'runtime' || fields.length === 0) {
    return patch
  }
  const joined = storedWithWindowView(partition, stored, { ...stored, ...patch })
  return withMainLayoutFields(patch, joined, fields)
}
