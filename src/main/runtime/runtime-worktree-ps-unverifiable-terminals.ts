import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeWorktreeSummaryPathIndex } from './runtime-worktree-summary-paths'

/**
 * Counts each terminal that was not counted live but whose host only lost contact.
 * A relay drop disconnects every one of the host's PTY records at once, so without this
 * the row read as no terminals at all (docs/reference/ssh-execution-boundary.md).
 */
export function applyRuntimeWorktreePsUnverifiableTerminals(args: {
  summaries: Map<string, RuntimeWorktreePsSummary>
  pathIndex: RuntimeWorktreeSummaryPathIndex
  missingIds: Set<string>
  countedPtyIds: ReadonlySet<string>
  leaves: Iterable<RuntimeLeafRecord>
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  getLivenessVerdict: (ptyId: string) => PtyLivenessVerdict | null
  getSummary: (
    summaries: Map<string, RuntimeWorktreePsSummary>,
    pathIndex: RuntimeWorktreeSummaryPathIndex,
    missingIds: Set<string>,
    worktreeId: string
  ) => RuntimeWorktreePsSummary | null
}): void {
  // Like the live pass, the host's PTY record owns the worktree; a pane only fills in a PTY with no record.
  const ownerByPtyId = new Map<string, string>()
  for (const pty of args.ptysById.values()) {
    ownerByPtyId.set(pty.ptyId, pty.worktreeId)
  }
  for (const leaf of args.leaves) {
    if (leaf.ptyId && !ownerByPtyId.has(leaf.ptyId)) {
      ownerByPtyId.set(leaf.ptyId, leaf.worktreeId)
    }
  }
  for (const [ptyId, worktreeId] of ownerByPtyId) {
    if (
      args.countedPtyIds.has(ptyId) ||
      args.getLivenessVerdict(ptyId)?.status !== 'unverifiable'
    ) {
      continue
    }
    const summary = args.getSummary(args.summaries, args.pathIndex, args.missingIds, worktreeId)
    if (summary) {
      summary.unverifiableTerminalCount = (summary.unverifiableTerminalCount ?? 0) + 1
      summary.hasHostSidebarActivity = true
    }
  }
}
