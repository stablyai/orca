import type { PtyLivenessVerdict } from '../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../terminal/records/runtime-terminal-state-records'
import type { RuntimeWorktreePsSummaryLookup } from './runtime-worktree-summary-paths'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { ptyRecordHostId } from './runtime-worktree-ps-activity'

/** A dropped relay loses contact with every host PTY at once; count unverifiable terminals so rows do not falsely report none (ssh-execution-boundary.md). */
export function applyRuntimeWorktreePsUnverifiableTerminals(args: {
  countedPtyIds: ReadonlySet<string>
  leaves: Iterable<RuntimeLeafRecord>
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
  getLivenessVerdict: (ptyId: string) => PtyLivenessVerdict | null
  getSummary: RuntimeWorktreePsSummaryLookup
}): void {
  // Like the live pass, the host's PTY record owns the worktree; a pane only fills in a PTY with no record.
  const ownerByPtyId = new Map<string, { worktreeId: string; hostId?: ExecutionHostId }>()
  for (const pty of args.ptysById.values()) {
    ownerByPtyId.set(pty.ptyId, { worktreeId: pty.worktreeId, hostId: ptyRecordHostId(pty) })
  }
  for (const leaf of args.leaves) {
    if (leaf.ptyId && !ownerByPtyId.has(leaf.ptyId)) {
      ownerByPtyId.set(leaf.ptyId, { worktreeId: leaf.worktreeId })
    }
  }
  for (const [ptyId, owner] of ownerByPtyId) {
    if (
      args.countedPtyIds.has(ptyId) ||
      args.getLivenessVerdict(ptyId)?.status !== 'unverifiable'
    ) {
      continue
    }
    const summary = args.getSummary(owner.worktreeId, owner.hostId)
    if (summary) {
      summary.unverifiableTerminalCount = (summary.unverifiableTerminalCount ?? 0) + 1
      summary.hasHostSidebarActivity = true
    }
  }
}
