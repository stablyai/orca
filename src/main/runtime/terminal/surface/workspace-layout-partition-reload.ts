// Reload only the workspaces a write reported, plus every workspace sharing a Loader ref with them; null whenever the partial result could differ from a whole load.

import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ReverseIndexedMap } from '../../../../shared/collections/reverse-indexed-map'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import {
  loadWorkspaceLayoutParts,
  workspaceKeys
} from '../../../../shared/workspace-layout/persistence/workspace-layout-load'
import {
  loadedShareRefs,
  sharedLeafOf,
  sharedRowOf,
  sliceWorkspaceSession,
  storedShareRefs,
  workspaceMembership
} from '../../../../shared/workspace-layout/persistence/workspace-layout-load-slice'
import type {
  LoadedWorkspaceLayout,
  LoadedWorkspaceLayoutRead,
  WorkspaceLayoutLoadContext
} from '../../../../shared/workspace-layout/persistence/workspace-layout-load-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

/** Past this many tied workspaces a whole load is as cheap and simpler to trust. */
const MAX_RELOADED_WORKSPACES = 64

/** What a whole load learned about how the partition's workspaces tie together. */
type PartitionRefs = {
  byKey: ReverseIndexedMap<string, ReadonlySet<string>, string>
  /** Partition order as of the last whole load or tied reload, and map membership. */
  rank: Map<string, number>
  membership: ReadonlyMap<string, number>
  subsumedByKey: Map<string, ReadonlyMap<string, string>>
}

export type PartitionLoad = {
  loaded: LoadedWorkspaceLayoutRead
  /** Absent when no part of the partition can reload alone. */
  refs?: PartitionRefs
}

function hasEntries(record: Readonly<Record<string, unknown>> | undefined): boolean {
  return record !== undefined && Object.keys(record).length > 0
}

function hasRowWithoutLayout(session: WorkspaceSessionState): boolean {
  return Object.values(session.tabsByWorktree ?? {}).some((rows) =>
    rows.some((row) => !session.terminalLayoutsByTabId?.[row.id])
  )
}

export function loadWholePartition(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  context: WorkspaceLayoutLoadContext
): PartitionLoad {
  const { loaded, subsumedByKey } = loadWorkspaceLayoutParts(hostId, session, context)
  // Window-owned builds, legacy surface tombstones and rows saved before pane layouts keep whole loads.
  if (
    !ORCA_LAYOUT_OWNER_IS_MAIN ||
    hasEntries(session.terminalSurfaceTombstonesByPaneKey) ||
    hasRowWithoutLayout(session)
  ) {
    return { loaded }
  }
  const membership = new Map<string, number>()
  const refs: PartitionRefs = {
    byKey: new ReverseIndexedMap((value) => value),
    rank: new Map(workspaceKeys(session).map((key, rank) => [key, rank])),
    membership,
    subsumedByKey
  }
  for (const key of refs.rank.keys()) {
    const stored = storedShareRefs(session, key)
    const workspace = loaded.layout.workspaces[key]
    if (!stored || !workspace) {
      return { loaded }
    }
    refs.byKey.set(key, new Set([...stored.refs, ...loadedShareRefs(workspace)]))
    membership.set(key, workspaceMembership(session, key))
  }
  return { loaded, refs }
}

/** The reloaded partition and the workspaces it reloaded; null when only a whole load is exact. */
export function reloadWorkspaces(
  hostId: ExecutionHostId,
  previous: PartitionLoad,
  session: WorkspaceSessionState,
  written: ReadonlySet<string>,
  context: WorkspaceLayoutLoadContext
): { load: PartitionLoad; keys: readonly string[] } | null {
  const { refs } = previous
  if (!refs || hasEntries(session.terminalSurfaceTombstonesByPaneKey)) {
    return null
  }
  const tied = tiedWorkspaces(refs, session, written)
  if (!tied) {
    return null
  }
  // With no workspace tied, the empty slice still refreshes partition-wide view selections.
  if (tied.size > 1) {
    // Tied workspaces load in partition order, which a write may have changed (a frozen workspace is re-added last).
    refs.rank = new Map(workspaceKeys(session).map((key, rank) => [key, rank]))
  }
  const keys = [...tied.keys()].sort((left, right) => refs.rank.get(left)! - refs.rank.get(right)!)
  const subsumedElsewhere = new Map<string, string>()
  for (const [key, subsumed] of refs.subsumedByKey) {
    if (!tied.has(key)) {
      subsumed.forEach((canonical, tabId) => subsumedElsewhere.set(tabId, canonical))
    }
  }
  const worktreeIds = new Set([...tied.values()].map(({ worktreeId }) => worktreeId))
  const part = loadWorkspaceLayoutParts(
    hostId,
    sliceWorkspaceSession(session, keys, worktreeIds),
    context,
    subsumedElsewhere
  )
  const nextRefs = new Map<string, ReadonlySet<string>>()
  for (const key of keys) {
    const workspace = part.loaded.layout.workspaces[key]
    if (!workspace) {
      return null
    }
    const all = new Set([...tied.get(key)!.refs, ...loadedShareRefs(workspace)])
    // A minted pane id or a newly resolved worktree id can tie a workspace the slice left out.
    for (const ref of all) {
      for (const sharer of refs.byKey.keysFor(ref)) {
        if (!tied.has(sharer)) {
          return null
        }
      }
    }
    nextRefs.set(key, all)
  }
  const loaded = mergeReloaded(previous.loaded, part.loaded, keys, refs.byKey)
  for (const [key, all] of nextRefs) {
    refs.byKey.set(key, all)
    const subsumed = part.subsumedByKey.get(key)
    if (subsumed) {
      refs.subsumedByKey.set(key, subsumed)
    } else {
      refs.subsumedByKey.delete(key)
    }
  }
  return { load: { loaded, refs }, keys }
}

/** The written workspaces closed under shared refs, old and new, with their stored refs; null past the cap or for a workspace whose place or legacy rows only a whole load resolves. */
function tiedWorkspaces(
  refs: PartitionRefs,
  session: WorkspaceSessionState,
  written: ReadonlySet<string>
): Map<string, { refs: ReadonlySet<string>; worktreeId: string }> | null {
  const tied = new Map<string, { refs: ReadonlySet<string>; worktreeId: string }>()
  if (written.size > MAX_RELOADED_WORKSPACES) {
    return null
  }
  const queued = new Set(written)
  const queue = [...written]
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    if (!refs.rank.has(key) || workspaceMembership(session, key) !== refs.membership.get(key)) {
      return null
    }
    const stored = storedShareRefs(session, key)
    if (!stored) {
      return null
    }
    tied.set(key, stored)
    for (const ref of [...stored.refs, ...(refs.byKey.get(key) ?? [])]) {
      for (const sharer of refs.byKey.keysFor(ref)) {
        if (!queued.has(sharer)) {
          if (queued.size === MAX_RELOADED_WORKSPACES) {
            return null
          }
          queued.add(sharer)
          queue.push(sharer)
        }
      }
    }
  }
  return tied
}

function assignOwn<T>(target: Record<string, T>, source: Record<string, T>): void {
  for (const [key, value] of Object.entries(source)) {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
}

/** Swap the reloaded workspaces' entries into copies; untouched workspaces keep their objects. */
function mergeReloaded(
  previous: LoadedWorkspaceLayoutRead,
  part: LoadedWorkspaceLayout,
  keys: readonly string[],
  previousRefs: ReverseIndexedMap<string, ReadonlySet<string>, string>
): LoadedWorkspaceLayoutRead {
  const workspaces = { ...previous.layout.workspaces }
  const view = {
    ...part.desktopView,
    groups: { ...previous.desktopView.groups },
    lastFocusedAt: { ...previous.desktopView.lastFocusedAt },
    panes: { ...previous.desktopView.panes },
    editorDrafts: { ...previous.desktopView.editorDrafts }
  }
  const facts = {
    ...part.facts,
    tabLabels: { ...previous.facts.tabLabels },
    terminalRows: { ...previous.facts.terminalRows },
    scrollback: { ...previous.facts.scrollback },
    browserTabs: { ...previous.facts.browserTabs }
  }
  const byWorkspace = [
    view.groups,
    view.lastFocusedAt,
    view.editorDrafts,
    facts.tabLabels,
    facts.browserTabs
  ]
  for (const key of keys) {
    workspaces[key] = part.layout.workspaces[key]!
    byWorkspace.forEach((record) => delete record[key])
    for (const ref of previousRefs.get(key) ?? []) {
      const row = sharedRowOf(ref)
      const leaf = sharedLeafOf(ref)
      if (row !== null) {
        delete view.panes[row]
        delete facts.terminalRows[row]
      } else if (leaf !== null) {
        delete facts.scrollback[leaf]
      }
    }
  }
  assignOwn(view.groups, part.desktopView.groups)
  assignOwn(view.lastFocusedAt, part.desktopView.lastFocusedAt)
  assignOwn(view.editorDrafts, part.desktopView.editorDrafts)
  assignOwn(view.panes, part.desktopView.panes)
  assignOwn(facts.tabLabels, part.facts.tabLabels)
  assignOwn(facts.browserTabs, part.facts.browserTabs)
  assignOwn(facts.terminalRows, part.facts.terminalRows)
  assignOwn(facts.scrollback, part.facts.scrollback)
  return { layout: { hostId: previous.layout.hostId, workspaces }, desktopView: view, facts }
}
