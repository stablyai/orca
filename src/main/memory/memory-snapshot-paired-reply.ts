import type { MemorySnapshot, WorktreeMemory } from '../../shared/diagnostics/process-stats-types'

/** What a sample recorded to rebuild the terminal-only snapshot paired clients have always received. */
export type PairedReplyParts = {
  /** Terminal-only usage, and a reader for their history, for workspaces that have had chats. */
  terminalRows: ReadonlyMap<
    string,
    { usage: Pick<WorktreeMemory, 'cpu' | 'memory' | 'privateMemory'>; readHistory: () => number[] }
  >
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

function pairedRow(wt: WorktreeMemory, parts: PairedReplyParts): WorktreeMemory {
  const terminal = parts.terminalRows.get(wt.worktreeId)
  const restored =
    parts.restoredSessionIds.size > 0 &&
    wt.sessions.some((session) => parts.restoredSessionIds.has(session.sessionId))
  if (!terminal && !restored) {
    return wt
  }
  const { chats: _chats, ...row } = wt
  return {
    ...row,
    ...(terminal ? { ...terminal.usage, history: terminal.readHistory() } : {}),
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
  const reply: MemorySnapshot = {
    ...base,
    worktrees: snapshot.worktrees
      .filter((wt) => wt.sessions.length > 0)
      .map((wt) => pairedRow(wt, parts)),
    ...parts.totals
  }
  replyBySnapshot.set(snapshot, reply)
  return reply
}
