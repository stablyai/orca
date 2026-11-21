import type {
  ChatAgentMemory,
  MemorySnapshot,
  SessionMemory,
  WorktreeMemory
} from '../../shared/diagnostics/process-stats-types'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../shared/remote-runtime/remote-runtime-memory-limits'
import { clampMemoryMetric, optionalCommitField } from './memory-snapshot-values'

// Paired clients draw a short sparkline, so a large host's reply drops older points first.
export const MEMORY_REPLY_HISTORY_POINTS = 20
// Room under the limit for the app section, host totals and the envelope.
const MEMORY_REPLY_BUDGET_BYTES = REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - 256 * 1024
// Upper bounds for keys, punctuation and numbers around each object's strings.
const ROW_OVERHEAD_BYTES = 200
const SESSION_OVERHEAD_BYTES = 160
const CHAT_OVERHEAD_BYTES = 160
const HISTORY_POINT_BYTES = 17

/** Serialized size of a JSON string, counted without encoding it; a surrogate pair counts 6. */
function jsonStringBytes(value: string | null | undefined): number {
  if (!value) {
    return 4
  }
  let bytes = 2
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    bytes += code === 34 || code === 92 ? 2 : code < 32 ? 6 : code < 128 ? 1 : code < 2048 ? 2 : 3
  }
  return bytes
}

function sessionBytes(session: SessionMemory): number {
  return (
    SESSION_OVERHEAD_BYTES + jsonStringBytes(session.sessionId) + jsonStringBytes(session.paneKey)
  )
}

function chatBytes(chat: ChatAgentMemory): number {
  return (
    CHAT_OVERHEAD_BYTES +
    jsonStringBytes(chat.agentSessionId) +
    jsonStringBytes(chat.agent) +
    jsonStringBytes(chat.name)
  )
}

function rowBytes(worktree: WorktreeMemory): number {
  let bytes =
    ROW_OVERHEAD_BYTES +
    jsonStringBytes(worktree.worktreeId) +
    jsonStringBytes(worktree.worktreeName) +
    jsonStringBytes(worktree.repoId) +
    jsonStringBytes(worktree.repoName)
  for (const session of worktree.sessions) {
    bytes += sessionBytes(session)
  }
  for (const chat of worktree.chats ?? []) {
    bytes += chatBytes(chat)
  }
  return bytes
}

/** A workspace sampled only for its chats; a terminal-only reply never had these rows. */
function isChatOnly(worktree: WorktreeMemory): boolean {
  return worktree.sessions.length === 0 && (worktree.chats?.length ?? 0) > 0
}

/** The reply terminals alone produce: the shape and totals the host sent before chats were sampled. */
function terminalOnlyReply(snapshot: MemorySnapshot): MemorySnapshot {
  const { agentProcesses: _agentProcesses, ...base } = snapshot
  const committed = snapshot.processCommitMetric !== undefined
  let cpu = 0
  let memory = 0
  let privateMemory = 0
  const worktrees = snapshot.worktrees
    .filter((worktree) => !isChatOnly(worktree))
    .map(({ chats: _chats, sessions, ...worktree }): WorktreeMemory => {
      let rowCpu = 0
      let rowMemory = 0
      let rowPrivate = 0
      for (const session of sessions) {
        rowCpu += session.cpu
        rowMemory += session.memory
        rowPrivate += clampMemoryMetric(session.privateMemory)
      }
      cpu += rowCpu
      memory += rowMemory
      privateMemory += committed ? clampMemoryMetric(rowPrivate) : 0
      return {
        ...worktree,
        cpu: rowCpu,
        memory: rowMemory,
        ...optionalCommitField(committed, rowPrivate),
        sessions: sessions.map((session) => ({ ...session, paneKey: null })),
        history: []
      }
    })
  return {
    ...base,
    app: { ...snapshot.app, history: [] },
    worktrees,
    ...(committed
      ? {
          totalPrivateMemory: clampMemoryMetric(
            clampMemoryMetric(snapshot.app.privateMemory) + privateMemory
          )
        }
      : {}),
    totalCpu: snapshot.app.cpu + cpu,
    totalMemory: snapshot.app.memory + memory
  }
}

function withHistory(snapshot: MemorySnapshot, points: number): MemorySnapshot {
  return {
    ...snapshot,
    app: { ...snapshot.app, history: points ? snapshot.app.history.slice(-points) : [] },
    worktrees: snapshot.worktrees.map((worktree) => ({
      ...worktree,
      history: points ? worktree.history.slice(-points) : []
    }))
  }
}

/**
 * The snapshot as sent over RPC. Near the size limit it drops older history, then all history,
 * then everything chat sampling adds (chat lists, chat-only rows, pane keys, the agent total and
 * chats' share of the totals), so a host never sends more than its terminals alone would.
 */
export function toMemorySnapshotReply(snapshot: MemorySnapshot): MemorySnapshot {
  let rows = 0
  let fullHistory = snapshot.app.history.length * HISTORY_POINT_BYTES
  let shortHistory = Math.min(snapshot.app.history.length, MEMORY_REPLY_HISTORY_POINTS)
  for (const worktree of snapshot.worktrees) {
    rows += rowBytes(worktree)
    fullHistory += worktree.history.length * HISTORY_POINT_BYTES
    shortHistory += Math.min(worktree.history.length, MEMORY_REPLY_HISTORY_POINTS)
  }
  if (rows + fullHistory <= MEMORY_REPLY_BUDGET_BYTES) {
    return snapshot
  }
  if (rows + shortHistory * HISTORY_POINT_BYTES <= MEMORY_REPLY_BUDGET_BYTES) {
    return withHistory(snapshot, MEMORY_REPLY_HISTORY_POINTS)
  }
  if (rows <= MEMORY_REPLY_BUDGET_BYTES) {
    return withHistory(snapshot, 0)
  }
  return terminalOnlyReply(snapshot)
}
