import type {
  ChatAgentMemory,
  MemorySnapshot,
  SessionMemory,
  WorktreeMemory
} from '../../shared/diagnostics/process-stats-types'
import {
  jsonStringContentBytes,
  REMOTE_RPC_MAX_CONTENT_BYTES
} from '../../shared/remote-runtime/rpc/remote-rpc-content-budget'
import { clampMemoryMetric, optionalCommitField } from './memory-snapshot-values'

// Paired clients draw a short sparkline, so a large host's reply drops older points first.
export const MEMORY_REPLY_HISTORY_POINTS = 20
// Room under the budget for the app section and host totals, which the estimate leaves out.
const ESTIMATE_RESERVE_BYTES = 256 * 1024
// Upper bounds for keys, punctuation and numbers around each object's strings.
const ROW_OVERHEAD_BYTES = 200
const SESSION_OVERHEAD_BYTES = 160
const CHAT_OVERHEAD_BYTES = 160
// The longest JSON number (`-1.2345678901234567e-308`) and its comma.
const HISTORY_POINT_BYTES = 25

/** A JSON string's serialized size. */
function jsonStringBytes(value: string | null | undefined): number {
  return value ? 2 + jsonStringContentBytes(value) : 4
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Exact `JSON.stringify` size of plain data, built from no string; past `limit` it stops and returns Infinity. */
function jsonBytes(value: unknown, limit: number): number {
  let bytes = 0
  const visit = (node: unknown, inArray: boolean): boolean => {
    if (bytes > limit) {
      return false
    }
    if (typeof node === 'string') {
      bytes += 2 + jsonStringContentBytes(node)
    } else if (typeof node === 'number') {
      bytes += Number.isFinite(node) ? String(node).length : 4
    } else if (typeof node === 'boolean') {
      bytes += node ? 4 : 5
    } else if (Array.isArray(node)) {
      bytes += 2 + Math.max(0, node.length - 1)
      for (const item of node) {
        if (!visit(item, true)) {
          return false
        }
      }
    } else if (isJsonRecord(node)) {
      let fields = 0
      bytes += 2
      for (const key in node) {
        const item = Object.hasOwn(node, key) ? node[key] : undefined
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
          continue
        }
        bytes += (fields++ ? 1 : 0) + 3 + jsonStringContentBytes(key)
        if (!visit(item, false)) {
          return false
        }
      }
    } else {
      // null, and undefined or functions inside an array, all serialize as null.
      bytes += inArray || node === null ? 4 : 0
    }
    return bytes <= limit
  }
  return visit(value, false) ? bytes : Number.POSITIVE_INFINITY
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

/** The reply terminals alone produce: the rows and totals the host sent before chats were sampled. */
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
        sessions
      }
    })
  return {
    ...base,
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

/** Restored terminals' pane keys are new in replies, so they go before any history does. */
function withoutPaneKeys(snapshot: MemorySnapshot): MemorySnapshot {
  return {
    ...snapshot,
    worktrees: snapshot.worktrees.map((worktree) => ({
      ...worktree,
      sessions: worktree.sessions.map((session) => ({ ...session, paneKey: null }))
    }))
  }
}

function paneKeyJsonBytes(snapshot: MemorySnapshot): number {
  let bytes = 0
  for (const worktree of snapshot.worktrees) {
    for (const session of worktree.sessions) {
      bytes += jsonStringBytes(session.paneKey) - 4
    }
  }
  return bytes
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

/** Exact JSON size of a number array keeping its last `keep` entries. */
function historyJsonBytes(history: readonly number[], keep: number): number {
  let bytes = 2 + Math.max(0, keep - 1)
  for (let i = history.length - keep; i < history.length; i++) {
    const point = history[i]
    bytes += Number.isFinite(point) ? String(point).length : 4
  }
  return bytes
}

/** Exact JSON size of every history array, keeping at most `points` per array. */
function allHistoryJsonBytes(snapshot: MemorySnapshot, points: number): number {
  let bytes = historyJsonBytes(snapshot.app.history, Math.min(points, snapshot.app.history.length))
  for (const worktree of snapshot.worktrees) {
    bytes += historyJsonBytes(worktree.history, Math.min(points, worktree.history.length))
  }
  return bytes
}

/** The first history length (full, 20 points, none) whose reply fits, given that reply's full size. */
function fittingHistory(
  snapshot: MemorySnapshot,
  fullBytes: number,
  budgetBytes: number
): MemorySnapshot | null {
  if (fullBytes <= budgetBytes) {
    return snapshot
  }
  if (!Number.isFinite(fullBytes)) {
    return null
  }
  const withoutHistory = fullBytes - allHistoryJsonBytes(snapshot, Number.POSITIVE_INFINITY)
  for (const points of [MEMORY_REPLY_HISTORY_POINTS, 0]) {
    if (withoutHistory + allHistoryJsonBytes(snapshot, points) <= budgetBytes) {
      return withHistory(snapshot, points)
    }
  }
  return null
}

/**
 * The snapshot as sent to a paired client, within `budgetBytes` of reply content. Chat detail is
 * extra, so near the limit it goes first (chat lists, chat-only rows, the agent total and chats'
 * share of the totals); then pane keys, older history and all history. A host never gives up what
 * its terminals alone would have sent.
 */
export function toMemorySnapshotReply(
  snapshot: MemorySnapshot,
  budgetBytes: number = REMOTE_RPC_MAX_CONTENT_BYTES
): MemorySnapshot {
  let estimate = snapshot.app.history.length * HISTORY_POINT_BYTES
  for (const worktree of snapshot.worktrees) {
    estimate += rowBytes(worktree) + worktree.history.length * HISTORY_POINT_BYTES
  }
  // The estimate is an upper bound, so most hosts are never measured; a measurement stops past its limit.
  if (
    estimate <= budgetBytes - ESTIMATE_RESERVE_BYTES ||
    jsonBytes(snapshot, budgetBytes) <= budgetBytes
  ) {
    return snapshot
  }
  const terminals = terminalOnlyReply(snapshot)
  const measureLimit = budgetBytes + allHistoryJsonBytes(terminals, Number.POSITIVE_INFINITY)
  const keyBytes = paneKeyJsonBytes(terminals)
  const terminalBytes = jsonBytes(terminals, measureLimit + keyBytes)
  if (terminalBytes <= budgetBytes) {
    return terminals
  }
  const keyless = withoutPaneKeys(terminals)
  return fittingHistory(keyless, terminalBytes - keyBytes, budgetBytes) ?? withHistory(keyless, 0)
}
