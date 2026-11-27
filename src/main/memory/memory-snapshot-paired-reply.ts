import type { MemorySnapshot, WorktreeMemory } from '../../shared/diagnostics/process-stats-types'
import { clampMemoryMetric, optionalCommitField } from './memory-snapshot-values'

/** What a sample recorded to rebuild the terminal-only snapshot paired clients have always received. */
export type PairedReplyParts = {
  /** False when every row is already what paired clients receive, so the reply sends them as they are. */
  rowsDiffer: boolean
  /** Rows without terminals exist, which paired replies leave out. */
  hasChatOnlyRows: boolean
  /** Terminal-only usage of workspaces that also have chats. */
  terminalSeries: readonly { worktreeId: string; usage: RowUsage }[]
  hasPrivateMemory: boolean
  /** A workspace's terminal-only history; read only for the rows that need it. */
  readTerminalHistory: (worktreeId: string) => number[]
  /** Per workspace, sessions whose pane key came from startup restore; paired replies send them without one. */
  restoredSessionIds: ReadonlyMap<string, ReadonlySet<string>>
  /** Indexes of the rows holding those sessions. */
  restoredRows: readonly number[]
  totals: Pick<
    MemorySnapshot,
    'processCommitMetric' | 'totalCpu' | 'totalMemory' | 'totalPrivateMemory'
  >
}

const partsBySnapshot = new WeakMap<MemorySnapshot, PairedReplyParts>()
const replyBySnapshot = new WeakMap<MemorySnapshot, MemorySnapshot>()

export function recordPairedReplyParts(snapshot: MemorySnapshot, parts: PairedReplyParts): void {
  partsBySnapshot.set(snapshot, parts)
}

type RowUsage = { cpu: number; memory: number; privateMemory: number }

function pairedRow(
  wt: WorktreeMemory,
  parts: PairedReplyParts,
  terminalUsage: ReadonlyMap<string, RowUsage>
): WorktreeMemory {
  const terminal = terminalUsage.get(wt.worktreeId)
  const restored = parts.restoredSessionIds.get(wt.worktreeId)
  if (!terminal && !restored) {
    return wt
  }
  const { chats: _chats, ...row } = wt
  return {
    ...row,
    ...(terminal
      ? {
          cpu: clampMemoryMetric(terminal.cpu),
          memory: clampMemoryMetric(terminal.memory),
          ...optionalCommitField(parts.hasPrivateMemory, terminal.privateMemory),
          history: parts.readTerminalHistory(wt.worktreeId)
        }
      : {}),
    sessions: restored
      ? wt.sessions.map((session) =>
          restored.has(session.sessionId) ? { ...session, paneKey: null } : session
        )
      : wt.sessions
  }
}

/**
 * The snapshot a paired client receives: terminals only, as before chats were sampled, so a host's
 * reply is the size it always was. Rows that already match are sent as they are.
 */
export function toPairedMemoryReply(snapshot: MemorySnapshot): MemorySnapshot {
  const parts = partsBySnapshot.get(snapshot)
  if (!parts) {
    return snapshot
  }
  const cached = replyBySnapshot.get(snapshot)
  if (cached) {
    return cached
  }
  const {
    agentProcesses: _agentProcesses,
    processCommitMetric: _metric,
    totalPrivateMemory: _private,
    ...base
  } = snapshot
  const terminalUsage = new Map(
    parts.terminalSeries.map(({ worktreeId, usage }) => [worktreeId, usage])
  )
  let worktrees: WorktreeMemory[] | undefined
  if (!parts.rowsDiffer) {
    worktrees = undefined
  } else if (!parts.hasChatOnlyRows && parts.terminalSeries.length === 0) {
    // Only restored pane keys differ, so only their workspaces' rows are rebuilt.
    worktrees = snapshot.worktrees.slice()
    for (const index of parts.restoredRows) {
      worktrees[index] = pairedRow(snapshot.worktrees[index], parts, terminalUsage)
    }
  } else {
    snapshot.worktrees.forEach((wt, i) => {
      const row =
        parts.hasChatOnlyRows && wt.sessions.length === 0
          ? undefined
          : pairedRow(wt, parts, terminalUsage)
      if (row !== wt) {
        // Copied only from the first row that differs.
        worktrees ??= snapshot.worktrees.slice(0, i)
      }
      if (worktrees && row) {
        worktrees.push(row)
      }
    })
  }
  const reply: MemorySnapshot = {
    ...base,
    worktrees: worktrees ?? snapshot.worktrees,
    ...parts.totals
  }
  replyBySnapshot.set(snapshot, reply)
  return reply
}
