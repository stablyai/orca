import type { RuntimeSessionTabCloseReason } from '../../shared/runtime-session-contracts'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { recordClosedTerminalTabTombstone } from '../../shared/closed-terminal-tab-tombstones'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'
import type { TerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'
import {
  closeTerminalTabInWorkspaceSession,
  type WorkspaceSessionTerminalTabCloseResult
} from '../../shared/workspace-session-terminal-tab-close'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'
import { advanceTerminalTopologyRevision } from './workspace-session-terminal-membership-authority'
import type { DurableProfileStateMutation } from '../persistence/loading-store/store-runtime-state'
import type { ExecutionHostId } from '../../shared/execution-host'

/** Where a pane close lands: its own removal, its tab's last pane, or a pane the copy lacks. */
export type PaneCloseResolution = 'pane' | 'last-pane' | 'absent'

export function collectTerminalLayoutLeafIds(
  node: TerminalPaneLayoutNode | null | undefined
): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectTerminalLayoutLeafIds(node.first), ...collectTerminalLayoutLeafIds(node.second)]
}

/**
 * Resolves a pane close against the panes one copy records. Only a copy that positively shows this
 * pane as its tab's one pane widens the close; a copy recording no panes knows nothing about it.
 */
export function resolvePaneClose(
  leafIds: readonly string[] | null,
  leafId: string
): PaneCloseResolution {
  if (!leafIds?.includes(leafId)) {
    return 'absent'
  }
  return leafIds.length === 1 ? 'last-pane' : 'pane'
}

/** Every copy of a tab's panes main can read when it resolves a close it started. */
export type TerminalCloseLayoutCopies = {
  /** The desktop renderer lists the tab, so it owns the tab's panes. */
  rendererListsTab: boolean
  /** The tab's rows in the published session snapshot. */
  snapshotRows: readonly { leafId: string; parentLayout?: TerminalLayoutSnapshot }[]
  /** The tab's panes in the renderer-published runtime graph. */
  graphLeafIds: readonly string[]
  sessionLayout: TerminalLayoutSnapshot | undefined
}

/** Reads the panes from whoever owns the tab's layout; `null` means no copy records any. */
function readLayoutOwnerLeafIds(copies: TerminalCloseLayoutCopies): readonly string[] | null {
  const published =
    copies.snapshotRows
      .map((row) => collectTerminalLayoutLeafIds(row.parentLayout?.root))
      .find((leafIds) => leafIds.length > 0) ?? []
  const rows = copies.snapshotRows.map((row) => row.leafId)
  // Why: main's saved layout lacks a renderer split whose PTY binding has not committed yet;
  // the published layout outranks the graph, which relay recovery can leave with stale panes.
  const ownerCopies = copies.rendererListsTab
    ? [published, copies.graphLeafIds, rows]
    : [collectTerminalLayoutLeafIds(copies.sessionLayout?.root), published, rows]
  // Why: a layout saved before its pane mounted (or a graph before its panes register) is empty.
  return ownerCopies.find((leafIds) => leafIds.length > 0) ?? null
}

/**
 * The only place main turns a pane close into its tab's close: `last-pane` sends callers down
 * the tab path (and its renderer pin guard); anything else closes that pane or nothing.
 * D1 (main as the single layout writer) collapses the owner read to main's session layout alone.
 */
export function resolveTerminalCloseTarget(
  target: TerminalSurfaceCloseTarget,
  copies: TerminalCloseLayoutCopies
): PaneCloseResolution | 'tab' {
  return target.kind === 'tab'
    ? 'tab'
    : resolvePaneClose(readLayoutOwnerLeafIds(copies), target.leafId)
}

export type TerminalSurfaceCloseResult = WorkspaceSessionTerminalTabCloseResult & {
  resolution: PaneCloseResolution | 'tab'
}

/**
 * The membership half of every explicit terminal close: removes a tab, or one pane of a split
 * tab, and advances the repo's topology revision so a stale renderer save cannot restore it.
 * A pane close only ever removes that pane; the resolution says why anything else was a no-op.
 * Every tab close is recorded in the session it was removed from, the owning host's partition.
 */
export function closeTerminalSurfaceInWorkspaceSession(
  session: WorkspaceSessionState,
  worktreeId: string,
  target: TerminalSurfaceCloseTarget,
  options: {
    force?: boolean
    paneIncarnationId?: string
    reason: RuntimeSessionTabCloseReason
    now?: number
  }
): TerminalSurfaceCloseResult {
  if (target.kind === 'pane') {
    const layout = session.terminalLayoutsByTabId[target.tabId]
    const resolution = resolvePaneClose(
      layout ? collectTerminalLayoutLeafIds(layout.root) : null,
      target.leafId
    )
    // Why: the exit may already have retired this pane, leaving only live siblings to lose.
    if (!layout || resolution !== 'pane') {
      return { session, ptyIdsToKill: [], closed: false, pinned: false, resolution }
    }
    // The pane's own binding is passed so the retirement's stale-binding fence always admits it;
    // the incarnation seen when the close was asked refuses a pane restarted since.
    const retired = retireTerminalSurfaceFromPersistence(session, {
      worktreeId,
      parentTabId: target.tabId,
      leafId: target.leafId,
      ptyId: layout.ptyIdsByLeafId?.[target.leafId] ?? '',
      ...(options.paneIncarnationId ? { incarnationId: options.paneIncarnationId } : {})
    })
    return {
      session: retired,
      ptyIdsToKill: [],
      closed: retired !== session,
      pinned: false,
      resolution
    }
  }
  const result = closeTerminalTabInWorkspaceSession(session, worktreeId, target.tabId, {
    force: options.force
  })
  // Why a tab this session never listed is still recorded: its spawn may commit later and graft it.
  if (result.pinned) {
    return { ...result, resolution: 'tab' }
  }
  const recorded: WorkspaceSessionState = {
    ...result.session,
    closedTerminalTabTombstonesByTabId: recordClosedTerminalTabTombstone(
      result.session.closedTerminalTabTombstonesByTabId,
      target.tabId,
      { worktreeId, reason: options.reason },
      options.now ?? Date.now()
    )
  }
  return {
    ...result,
    session: result.closed ? advanceTerminalTopologyRevision(recorded, worktreeId) : recorded,
    resolution: 'tab'
  }
}

/** What one close's durable mutation reads and writes, resolved when the writer admits it. */
export type TerminalSurfaceCloseCommit = {
  worktreeId: string
  target: TerminalSurfaceCloseTarget
  options: { allowMissing?: boolean; force?: boolean; reason?: RuntimeSessionTabCloseReason }
  /** The session as it was when the close was asked, before the writer admitted it. */
  requestedSession: WorkspaceSessionState | null | undefined
  /** The tab's owner identity still matches the one the close was asked against. */
  ownerMatches: () => boolean
  hostId: () => ExecutionHostId
  getSession: (hostId: ExecutionHostId) => WorkspaceSessionState | null | undefined
  setSession: (session: WorkspaceSessionState, hostId: ExecutionHostId) => void
  onClosed: (ptyIdsToKill: string[]) => void
}

/** Builds the close's durable mutation: a refusal persists nothing and is its value. */
export function terminalSurfaceCloseMutation(
  commit: TerminalSurfaceCloseCommit
): () => DurableProfileStateMutation<Error | undefined> {
  const { target } = commit
  // Why: a pane is fenced by its own binding, so a sibling split during the write cannot refuse it.
  const paneIncarnationId =
    target.kind === 'pane'
      ? commit.requestedSession?.terminalPtyIncarnationsByPaneKey?.[
          `${target.tabId}:${target.leafId}`
        ]
      : undefined
  return () => {
    if (!commit.ownerMatches()) {
      return { value: new Error('terminal_pane_owner_changed'), persist: false }
    }
    const hostId = commit.hostId()
    const session = commit.getSession(hostId)
    if (!session) {
      return { value: new Error('workspace_session_unavailable'), persist: false }
    }
    const result = closeTerminalSurfaceInWorkspaceSession(session, commit.worktreeId, target, {
      force: commit.options.force,
      paneIncarnationId,
      reason: commit.options.reason ?? 'user'
    })
    if (result.pinned) {
      return { value: new Error('terminal_tab_pinned'), persist: false }
    }
    if (!result.closed) {
      // Why: a tab this session never listed still records its close, so its late spawn is refused.
      if (commit.options.allowMissing && result.session !== session) {
        commit.setSession(result.session, hostId)
        return { value: undefined }
      }
      return {
        value: commit.options.allowMissing ? undefined : new Error('tab_not_found'),
        persist: false
      }
    }
    commit.setSession(result.session, hostId)
    commit.onClosed(result.ptyIdsToKill)
    // Why no rollback: bookkeeping must not undo a user's close or skip its kill; a failed write
    // keeps the removal dirty in memory, so the next write persists it.
    return { value: undefined }
  }
}
