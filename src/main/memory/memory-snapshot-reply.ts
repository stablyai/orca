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

// Measured as serialized, so escaped quotes and control characters count.
function textBytes(value: string | null | undefined): number {
  return value ? Buffer.byteLength(JSON.stringify(value), 'utf8') : 0
}

function sessionBytes(session: SessionMemory): number {
  return SESSION_OVERHEAD_BYTES + textBytes(session.sessionId)
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

/** A workspace sampled only for its chats; main's terminal-only reply never had these rows. */
function isChatOnly(worktree: WorktreeMemory): boolean {
  return worktree.sessions.length === 0 && (worktree.chats?.length ?? 0) > 0
}

/**
 * The snapshot as sent over RPC: every row with its totals, and at most 20 history points each.
 * Near the size limit it sheds, in order, history, chat lists, chat-only rows and pane keys, so
 * what this view adds never pushes a host past the payload it sent before; terminal rows,
 * sessions and totals always stay.
 */
export function toMemorySnapshotReply(snapshot: MemorySnapshot): MemorySnapshot {
  let core = 0
  let paneKeys = 0
  let chatOnlyRows = 0
  let chats = 0
  let histories = 0
  for (const worktree of snapshot.worktrees) {
    let bytes = rowBytes(worktree)
    for (const session of worktree.sessions) {
      bytes += sessionBytes(session)
      paneKeys += textBytes(session.paneKey)
    }
    if (isChatOnly(worktree)) {
      chatOnlyRows += bytes
    } else {
      core += bytes
    }
    histories += Math.min(worktree.history.length, MEMORY_REPLY_HISTORY_POINTS) * NUMBER_BYTES
    for (const chat of worktree.chats ?? []) {
      chats += chatBytes(chat)
    }
  }
  const budget = MEMORY_REPLY_BUDGET_BYTES
  const keepPaneKeys = core + paneKeys <= budget
  const keepChatOnlyRows = keepPaneKeys && core + paneKeys + chatOnlyRows <= budget
  const keepChats = keepChatOnlyRows && core + paneKeys + chatOnlyRows + chats <= budget
  const keepHistory = keepChats && core + paneKeys + chatOnlyRows + chats + histories <= budget
  const worktrees = keepChatOnlyRows
    ? snapshot.worktrees
    : snapshot.worktrees.filter((worktree) => !isChatOnly(worktree))
  return {
    ...snapshot,
    app: { ...snapshot.app, history: snapshot.app.history.slice(-MEMORY_REPLY_HISTORY_POINTS) },
    worktrees: worktrees.map(({ chats: rowChats, history, sessions, ...worktree }) => ({
      ...worktree,
      sessions: keepPaneKeys
        ? sessions
        : sessions.map((session) => ({ ...session, paneKey: null })),
      history: keepHistory ? history.slice(-MEMORY_REPLY_HISTORY_POINTS) : [],
      ...(keepChats && rowChats ? { chats: rowChats } : {})
    }))
  }
}
