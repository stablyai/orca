import type {
  ChatAgentMemory,
  MemorySnapshot,
  SessionMemory,
  WorktreeMemory
} from '../../shared/diagnostics/process-stats-types'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../shared/remote-runtime/remote-runtime-memory-limits'

// Paired clients draw a short sparkline; full 60-point histories on every workspace can push a
// large host's reply past the RPC size limit, which a client shows as the host being unreachable.
export const MEMORY_REPLY_HISTORY_POINTS = 20
// Room under the limit for the app section, host totals and the envelope.
const MEMORY_REPLY_BUDGET_BYTES = REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - 256 * 1024
// Generous per-object and per-number costs (keys, quotes, punctuation and a 17-digit number).
const ROW_OVERHEAD_BYTES = 200
const SESSION_OVERHEAD_BYTES = 160
const CHAT_OVERHEAD_BYTES = 160
const NUMBER_BYTES = 24

function textBytes(value: string | null | undefined): number {
  return value ? Buffer.byteLength(value, 'utf8') : 0
}

function sessionBytes(session: SessionMemory): number {
  return SESSION_OVERHEAD_BYTES + textBytes(session.sessionId) + textBytes(session.paneKey)
}

function chatBytes(chat: ChatAgentMemory): number {
  return (
    CHAT_OVERHEAD_BYTES +
    textBytes(chat.agentSessionId) +
    textBytes(chat.agent) +
    textBytes(chat.name)
  )
}

function rowBytes(worktree: WorktreeMemory): number {
  return (
    ROW_OVERHEAD_BYTES +
    textBytes(worktree.worktreeId) +
    textBytes(worktree.worktreeName) +
    textBytes(worktree.repoId) +
    textBytes(worktree.repoName)
  )
}

/**
 * The snapshot as sent over RPC: every row with its totals, and at most 20 history points each.
 * Near the size limit, history and then chat detail are left out, so they never make the host unreachable.
 */
export function toMemorySnapshotReply(snapshot: MemorySnapshot): MemorySnapshot {
  let rows = 0
  let histories = 0
  let chats = 0
  for (const worktree of snapshot.worktrees) {
    rows += rowBytes(worktree)
    for (const session of worktree.sessions) {
      rows += sessionBytes(session)
    }
    histories += Math.min(worktree.history.length, MEMORY_REPLY_HISTORY_POINTS) * NUMBER_BYTES
    for (const chat of worktree.chats ?? []) {
      chats += chatBytes(chat)
    }
  }
  const keepHistory = rows + chats + histories <= MEMORY_REPLY_BUDGET_BYTES
  const keepChats = rows + chats <= MEMORY_REPLY_BUDGET_BYTES
  return {
    ...snapshot,
    app: { ...snapshot.app, history: snapshot.app.history.slice(-MEMORY_REPLY_HISTORY_POINTS) },
    worktrees: snapshot.worktrees.map(({ chats: rowChats, history, ...worktree }) => ({
      ...worktree,
      history: keepHistory ? history.slice(-MEMORY_REPLY_HISTORY_POINTS) : [],
      ...(keepChats && rowChats ? { chats: rowChats } : {})
    }))
  }
}
