import type { BotSidebarView } from '../../../src/shared/bots/bot-sidebar-view'
import { getFolderWorkspaceChildWorktrees } from '../../../src/shared/folder-workspace-child-worktrees'
import type { WorkspaceLineage } from '../../../src/shared/worktree/lineage-types'
import { workspaceKeyOfRow } from '../../../src/shared/workspace/identity/workspace-scope'
import type { Worktree as HostWorktree } from '../../../src/shared/worktree/types'
import type { WorkspaceListItem, Worktree } from '../worktree/workspace-list/workspace-list-types'
import { isWorktreeActive } from '../worktree/workspace-list/workspace-row-filtering'
import {
  getWorktreeDotStatus,
  getWorktreeStatus
} from '../worktree/workspace-list/workspace-list-ordering'
import {
  countLiveBotWorkspaces,
  type BotWorkspaceLiveCounts
} from '../../../src/shared/bots/bot-sidebar-workspaces'
import { botLineLanes, lanesNeedingYouFirst } from '../../../src/shared/bots/bot-line-lanes'
import { asHostWorktree } from '../worktree/catalog/host-worktree-from-row'
import { getWorktreeRowIdentity } from '../worktree/row-presentation/worktree-host-row-identity'
import {
  getMobileWorkspaceLineageChildren,
  type MobileLineageStores
} from '../worktree/agent-lineage/mobile-workspace-lineage'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../src/shared/worktree/host-qualified-identity'

/** The list's nesting as the phone's resolver places it over every listed store, keyed by host
 * identity: the same parents its project list draws, so each bot branch reads them. */
export type HostBotLineage = {
  childrenByParentIdentity: ReadonlyMap<string, readonly HostWorktree[]>
  rowByIdentity: ReadonlyMap<string, Worktree>
  hostOf: (row: Worktree) => ExecutionHostId
}

/** Resolved once over every listed store, and only when first read: a host listing no bot never asks.
 * A host's own folder records place its rows that do not report their folder parent themselves. */
export function lazyHostBotLineage(
  rows: readonly Worktree[],
  stores: MobileLineageStores | undefined,
  hostOf: (row: Worktree) => ExecutionHostId,
  folderRecordsByHost: ReadonlyMap<ExecutionHostId, Readonly<Record<string, WorkspaceLineage>>>
): () => HostBotLineage {
  let lineage: HostBotLineage | undefined
  return () => (lineage ??= resolveHostBotLineage(rows, stores, hostOf, folderRecordsByHost))
}

function resolveHostBotLineage(
  rows: readonly Worktree[],
  stores: MobileLineageStores | undefined,
  hostOf: (row: Worktree) => ExecutionHostId,
  folderRecordsByHost: ReadonlyMap<ExecutionHostId, Readonly<Record<string, WorkspaceLineage>>>
): HostBotLineage {
  const identity = (row: Worktree) => composeWorktreeHostIdentity(hostOf(row), row.worktreeId)
  const recordOf = (row: Worktree) =>
    folderRecordsByHost.get(hostOf(row))?.[workspaceKeyOfRow(row.worktreeId)]
  const rowByRowIdentity = new Map(rows.map((row) => [getWorktreeRowIdentity(row), row]))
  const childrenByParentIdentity = new Map<string, HostWorktree[]>()
  for (const [parentRowIdentity, children] of getMobileWorkspaceLineageChildren(
    rows,
    stores,
    [],
    recordOf
  )) {
    const parent = rowByRowIdentity.get(parentRowIdentity)
    if (!parent) {
      continue
    }
    childrenByParentIdentity.set(
      identity(parent),
      children.map((child) => asHostWorktree(child, hostOf(child)))
    )
  }
  return {
    childrenByParentIdentity,
    rowByIdentity: new Map(rows.map((row) => [identity(row), row])),
    hostOf
  }
}

/** The bot's own workers' live counts, as its Bots list row counts them, for a row drawn without
 *  its worker lines (Home). */
export function hostBotWorkerCounts(
  homeRow: Worktree,
  lineage: HostBotLineage
): BotWorkspaceLiveCounts {
  const { childWorktrees } = getFolderWorkspaceChildWorktrees(
    composeWorktreeHostIdentity(lineage.hostOf(homeRow), homeRow.worktreeId),
    lineage.childrenByParentIdentity
  )
  return countLiveBotWorkspaces(
    childWorktrees.flatMap((worker) => {
      const row = lineage.rowByIdentity.get(getWorktreeHostIdentity(worker))
      return row ? [getWorktreeDotStatus(row)] : []
    })
  )
}

/** One worker's workspace by its id, and its lines: its own first, then its children's. */
export type HostBotWorkerBranch = { id: string; lines: WorkspaceListItem[] }

/** A bot's worker lines under its row, each worker followed by its own children. */
export function hostBotWorkerLines(args: {
  listing: { view: BotSidebarView }
  homeRow: Worktree
  lineage: HostBotLineage
  drawRow: (row: Worktree) => WorkspaceListItem
  paused: boolean
}): {
  /** The bot's own workers, which its fold counts. */
  workers: Worktree[]
  /** Every line, shown or not, which the project list leaves out. */
  allLines: WorkspaceListItem[]
  lines: WorkspaceListItem[]
  /** The shown workers, each with its line and its children's, which a chat lists together. */
  branches: HostBotWorkerBranch[]
} {
  const { listing, lineage } = args
  const { rowByIdentity, hostOf } = lineage
  const { childWorktrees, lineageChildrenByParentIdentity } = getFolderWorkspaceChildWorktrees(
    composeWorktreeHostIdentity(hostOf(args.homeRow), args.homeRow.worktreeId),
    lineage.childrenByParentIdentity
  )
  // The phone keeps an older host's lineage loops; a line is drawn once.
  const seen = new Set<string>()
  const pushLine = (worktree: HostWorktree, depth: number, lines: WorkspaceListItem[]) => {
    const identity = getWorktreeHostIdentity(worktree)
    const row = rowByIdentity.get(identity)
    if (seen.has(identity) || !row) {
      return
    }
    seen.add(identity)
    const drawn = args.drawRow(row)
    lines.push({
      row: drawn.row,
      view: {
        ...drawn.view,
        botWorkspace: true,
        showProjectName: true,
        lineageDepth: 0,
        lineageChildCount: 0,
        projectGroupDepth: depth,
        ...(args.paused ? { dimmed: true } : {})
      }
    })
  }
  // A worker's line, then every workspace under it at one level, those waiting on the owner first.
  const addLines = (worktree: HostWorktree, depth: number, lines: WorkspaceListItem[]) => {
    pushLine(worktree, depth, lines)
    const lanes = botLineLanes(
      worktree,
      (line) => lineageChildrenByParentIdentity.get(getWorktreeHostIdentity(line)) ?? [],
      getWorktreeHostIdentity
    )
    const needsYou = (line: HostWorktree) => {
      const row = rowByIdentity.get(getWorktreeHostIdentity(line))
      return row !== undefined && getWorktreeStatus(row) === 'permission'
    }
    for (const lane of lanesNeedingYouFirst(lanes, needsYou)) {
      pushLine(lane, depth + 1, lines)
    }
    return lines
  }
  const byRoot = childWorktrees.map((worktree) => ({
    root: rowByIdentity.get(getWorktreeHostIdentity(worktree)),
    lines: addLines(worktree, 1, [])
  }))
  // Hide sleeping workers drops a sleeping worker with its children, as the projects' Hide sleeping
  // does, but never the open line's branch (the drawn row's isActive is the host's or this phone's pick).
  const shown = byRoot.filter(
    ({ root, lines }) =>
      !listing.view.hideSleepingWorkers ||
      !root ||
      isWorktreeActive(root) ||
      lines.some((line) => line.row.isActive)
  )
  return {
    workers: byRoot.flatMap(({ root }) => root ?? []),
    allLines: byRoot.flatMap(({ lines }) => lines),
    lines: shown.flatMap(({ lines }) => lines),
    branches: shown.flatMap(({ root, lines }) => (root ? [{ id: root.worktreeId, lines }] : []))
  }
}
