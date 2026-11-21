import type { MemorySnapshot, WorktreeMemory } from '../../shared/diagnostics/process-stats-types'
import { clampMemoryMetric, optionalCommitField } from './memory-snapshot-values'

/** What a sample recorded to rebuild the terminal-only snapshot paired clients have always received. */
export type PairedReplyParts = {
  /** Terminal-only usage of workspaces that have had chats; their history is read only when asked. */
  terminalSeries: readonly { worktreeId: string; usage: RowUsage }[]
  hasPrivateMemory: boolean
  readTerminalHistory: (worktreeId: string) => number[]
  /** Sessions whose pane key came from startup restore; paired replies send them without one. */
  restoredSessionIds: ReadonlySet<string>
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
  const restored =
    parts.restoredSessionIds.size > 0 &&
    wt.sessions.some((session) => parts.restoredSessionIds.has(session.sessionId))
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
          parts.restoredSessionIds.has(session.sessionId) ? { ...session, paneKey: null } : session
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
  const reply: MemorySnapshot = {
    ...base,
    worktrees: snapshot.worktrees
      .filter((wt) => wt.sessions.length > 0)
      .map((wt) => pairedRow(wt, parts, terminalUsage)),
    ...parts.totals
  }
  replyBySnapshot.set(snapshot, reply)
  return reply
}
