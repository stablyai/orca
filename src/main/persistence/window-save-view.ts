// Preserve main-owned layout while merging renderer views/facts; paired-server mirrors pass through.

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
import type { ShutdownReconnectFacts } from '../runtime/terminal/recovery/shutdown-reconnect-facts'

const FIELD_OWNERS: Readonly<Record<string, string>> = SESSION_FIELD_OWNERS

function isLayoutField(field: string): boolean {
  const owner = Object.hasOwn(FIELD_OWNERS, field) ? FIELD_OWNERS[field] : undefined
  return owner === 'layout' || owner === 'legacy'
}

/** Visited empty workspaces retain owner rows so recorded closes survive relaunch. */
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

function joinWindowView(
  main: LoadedWorkspaceLayout,
  windows: LoadedWorkspaceLayout
): WorkspaceSessionState {
  return saveWorkspaceLayout({
    layout: withVisitedRowOwners(main.layout, windows.desktopView.lastVisitedAtByWorktreeId),
    desktopView: windows.desktopView,
    facts: windows.facts,
    // Unowned layout/resume fragments remain main-authored too.
    carried: {
      ...windows.carried,
      unownedTerminalLayouts: main.carried.unownedTerminalLayouts,
      unplacedSleepingRecords: main.carried.unplacedSleepingRecords,
      unplacedIncarnations: main.carried.unplacedIncarnations,
      unplacedClosedTabs: main.carried.unplacedClosedTabs
    }
  })
}

/** Patch only records changed by the view merge; preserve untouched stored representation. */
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

/** Merge full renderer saves/shutdown staging into main-owned layout. */
export function windowViewSaveForMain(
  stored: WorkspaceSessionState,
  save: WorkspaceSessionState,
  hostId: string | null | undefined,
  reconnectFacts?: ReconnectFactsFor
): WorkspaceSessionState {
  const partition = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  if (parseExecutionHostId(partition)?.kind === 'runtime') {
    return save
  }
  const joined = storedWithWindowView(partition, stored, save)
  const fields = [...new Set([...Object.keys(save), ...Object.keys(joined)])]
  const result = withMainLayoutFields(save, joined, fields.filter(isLayoutField))
  // Recompute reconnect evidence in main rather than trusting renderer snapshots.
  return reconnectFacts
    ? withReconnectFacts(result, reconnectFacts(result, partition), RECONNECT_FACT_FIELDS)
    : result
}

export type ReconnectFactsFor = (
  session: WorkspaceSessionState,
  partition: ExecutionHostId
) => ShutdownReconnectFacts

const RECONNECT_FACT_FIELDS = [
  'activeWorktreeIdsOnShutdown',
  'remoteSessionIdsByTabId',
  'activeConnectionIdsAtShutdown'
] as const satisfies readonly (keyof ShutdownReconnectFacts)[]

function withReconnectFacts<T extends WorkspaceSessionPatch>(
  session: T,
  facts: ShutdownReconnectFacts,
  fields: readonly (keyof ShutdownReconnectFacts)[]
): T {
  const next: T = { ...session }
  for (const field of fields) {
    if (facts[field] === undefined) {
      delete next[field]
    } else {
      Object.assign(next, { [field]: facts[field] })
    }
  }
  return next
}

/** Merge carried layout fields; scalar-only patches skip layout normalization. */
export function windowViewPatchForMain(
  stored: WorkspaceSessionState,
  patch: WorkspaceSessionPatch,
  hostId: string | null | undefined,
  reconnectFacts?: ReconnectFactsFor
): WorkspaceSessionPatch {
  const partition = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  if (parseExecutionHostId(partition)?.kind === 'runtime') {
    return patch
  }
  const fields = Object.keys(patch).filter(isLayoutField)
  const joined =
    fields.length === 0 ? null : storedWithWindowView(partition, stored, { ...stored, ...patch })
  const result = joined ? withMainLayoutFields(patch, joined, fields) : patch
  // Replace only reconnect fields actually present in the patch.
  const carried = RECONNECT_FACT_FIELDS.filter((field) => Object.hasOwn(patch, field))
  return reconnectFacts && carried.length > 0
    ? withReconnectFacts(result, reconnectFacts({ ...stored, ...result }, partition), carried)
    : result
}
