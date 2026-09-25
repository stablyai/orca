import { resolveOpenCodeDataDirectory } from './opencode-data-directory'
import {
  bindOpenCodeSession,
  type OpenCodeSessionBinding
} from '../../shared/agent-hook-listener/opencode-session-registry'
import {
  correlateOpenCodeSessionOwners,
  type CorrelatedClient,
  type CorrelatedPane,
  type CorrelatedSession,
  type SessionOwnership
} from '../../shared/agent-hook-listener/opencode-session-correlation'
import { readOpenCodeDatabase } from '../ai-vault/session-scanner-opencode-sqlite-open'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { listRegisteredPtys } from '../memory/pty-registry'
import type SyncDatabase from '../sqlite/sync-database'
import { isOpenCodeClientProcess, type ProcessIdentityRow } from './opencode-client-sweep'
import type { HookListenerState } from '../../shared/agent-hook-listener/listener-state'

/**
 * Main-process binder feeding the session→pane registry (#21359).
 *
 * Each round: read new sessions from the shared server's SQLite store,
 * snapshot panes, sweep for live clients, correlate, bind. Everything the
 * round needs is injected so the decision core stays unit-testable; only
 * the SQLite reader below touches disk, reusing ai-vault's guarded open
 * (read-only + query_only + busy timeout).
 */

/** One pane snapshot feeding a binder round. */
export type BinderPaneSnapshot = {
  paneKey: string
  /** Worktree root backing the pane (null when unknown); sessions beneath it are candidates. */
  directory: string | null
  worktreeId: string | null
  shellPid: number | null
  /**
   * ms epoch of the pane's last prompt activity (renderer keystroke, or a
   * prompt Orca delivered host-side), null when neither has happened since it
   * registered. Breaks same-directory ties.
   */
  lastInputAtMs: number | null
}

/** One session store row feeding a binder round. */
export type BinderSessionRow = {
  id: string
  directory: string
  createdAtMs: number
  parentId: string | null
}

/** Everything one binder round needs, injected for tests. */
export type BinderRoundDeps = {
  nowMs: number
  sessions: readonly BinderSessionRow[]
  panes: readonly BinderPaneSnapshot[]
  processes: readonly ProcessIdentityRow[]
  knownOwners: ReadonlyMap<string, string>
  parentBySessionId: ReadonlyMap<string, string | null>
}

/** Ownership decisions from one binder round. */
export type BinderRoundResult = {
  ownerships: SessionOwnership[]
}

/** Position in the session store; composite so same-millisecond rows are never skipped. */
export type OpenCodeSessionCursor = {
  ms: number
  id: string
}

/** Cursor before anything was ever read. */
export const OPENCODE_SESSION_CURSOR_START: OpenCodeSessionCursor = { ms: 0, id: '' }

/** Order cursors the way the store lists rows: oldest first, id as tiebreak. */
function compareSessionRows(left: OpenCodeSessionCursor, right: OpenCodeSessionCursor): number {
  return left.ms - right.ms || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

/**
 * Advance the store cursor past handled rows only. `fresh` arrives in store
 * order; handling is prefix-closed (the unbound-cap break only ever skips the
 * tail), so the first unhandled row freezes the cursor and every row at or
 * past it is re-listed next round instead of silently dropped.
 */
export function advanceBinderCursor(args: {
  fresh: readonly BinderSessionRow[]
  isHandled: (sessionId: string) => boolean
  current: OpenCodeSessionCursor
}): OpenCodeSessionCursor {
  let cursor = args.current
  for (const session of args.fresh) {
    if (!args.isHandled(session.id)) {
      break
    }
    const candidate: OpenCodeSessionCursor = { ms: session.createdAtMs, id: session.id }
    if (compareSessionRows(candidate, cursor) > 0) {
      cursor = candidate
    }
  }
  return cursor
}

/** pid→ppid index for one sweep; first row wins on duplicate pids. */
function childrenIndex(processes: readonly ProcessIdentityRow[]): Map<number, number> {
  const ppidByPid = new Map<number, number>()
  for (const row of processes) {
    if (!ppidByPid.has(row.pid)) {
      ppidByPid.set(row.pid, row.ppid)
    }
  }
  return ppidByPid
}

/** Nearest pane shell at or above this pid; external terminals stay unattributed. */
function owningPane(
  ppidByPid: Map<number, number>,
  shellPidByPid: Map<number, string>,
  pid: number
): string | null {
  const seen = new Set<number>()
  let current: number | undefined = pid
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    const owner = shellPidByPid.get(current)
    if (owner) {
      return owner
    }
    current = ppidByPid.get(current)
  }
  return null
}

/** Attribute opencode client rows to panes via shell-subtree walks. */
function toCorrelatedClients(
  processes: readonly ProcessIdentityRow[],
  panes: readonly BinderPaneSnapshot[],
  nowMs: number
): CorrelatedClient[] {
  const ppidByPid = childrenIndex(processes)
  const shellPidByPid = new Map<number, string>()
  for (const pane of panes) {
    if (pane.shellPid !== null && !shellPidByPid.has(pane.shellPid)) {
      shellPidByPid.set(pane.shellPid, pane.paneKey)
    }
  }
  const clients: CorrelatedClient[] = []
  for (const row of processes) {
    if (!isOpenCodeClientProcess(row)) {
      continue
    }
    const paneKey = owningPane(ppidByPid, shellPidByPid, row.pid)
    if (!paneKey) {
      continue
    }
    // Why lastSeenAlive = now: the sweep just observed it. Bracketing uses
    // startedAt for the lower bound and this observation for the upper.
    clients.push({ paneKey, startedAtMs: row.startedAtMs, lastSeenAliveMs: nowMs, argv: row.argv })
  }
  return clients
}

/** Most recent of two observations; null when neither side has one. */
function mostRecentInput(
  left: number | null | undefined,
  right: number | null | undefined
): number | null {
  if (typeof left !== 'number') {
    return typeof right === 'number' ? right : null
  }
  if (typeof right !== 'number') {
    return left
  }
  return Math.max(left, right)
}

/** Pure round core: correlate unbound sessions against panes and clients. */
export function runOpenCodeBinderRound(deps: BinderRoundDeps): BinderRoundResult {
  // Why dedupe by key, newest wins: remints and reattachments can leave a
  // stale registry row beside the live one; counting rows instead of panes
  // would turn every same-pane tie into a false ambiguous and nothing would
  // ever bind, while the oldest row would point the candidate set at a dead
  // worktree.
  const paneByKey = new Map<string, CorrelatedPane>()
  for (const pane of deps.panes) {
    const previous = paneByKey.get(pane.paneKey)
    // Why the directory check: a pane that moved (detached into another tab,
    // reminted against a different root) must not inherit input recorded under
    // its old directory, or a session in the new one could win a tie on
    // keystrokes that never happened there.
    const carriedInput =
      previous && previous.directory === pane.directory
        ? mostRecentInput(previous.lastInputAtMs, pane.lastInputAtMs)
        : pane.lastInputAtMs
    paneByKey.set(pane.paneKey, {
      paneKey: pane.paneKey,
      directory: pane.directory,
      // Why most-recent instead of the current row's own value: a reminted
      // PTY re-registers with no input history, so the replaced row's
      // observation is the only record of what the human typed there.
      lastInputAtMs: carriedInput
    })
  }
  const panes = [...paneByKey.values()]
  const clients = toCorrelatedClients(deps.processes, deps.panes, deps.nowMs)
  const sessions: CorrelatedSession[] = deps.sessions.map((row) => ({
    id: row.id,
    directory: row.directory,
    createdAtMs: row.createdAtMs,
    parentId: row.parentId
  }))
  // Why resolve inheritance here: the SQLite round only carries new rows, so
  // an old root is invisible to the correlator; the binder's parent map walks
  // the chain and the registry supplies the known root owner. Resolved heirs
  // are emitted as binds (the registry lacks them) and fed back as known so
  // the correlator skips what is already decided.
  const knownOwners = new Map(deps.knownOwners)
  const inherited: SessionOwnership[] = []
  for (const session of sessions) {
    if (knownOwners.has(session.id) || !session.parentId) {
      continue
    }
    let parent: string | null | undefined = session.parentId
    const seen = new Set<string>([session.id])
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      const owner = knownOwners.get(parent)
      if (owner) {
        knownOwners.set(session.id, owner)
        inherited.push({ sessionId: session.id, paneKey: owner, basis: 'creation-correlation' })
        break
      }
      parent = deps.parentBySessionId.get(parent)
    }
  }
  const ownerships = [
    ...inherited,
    ...correlateOpenCodeSessionOwners({
      sessions,
      panes,
      clients,
      knownOwners
    })
  ]
  return { ownerships }
}

/** True when the v2 session table has every column the binder reads. */
function canReadSessionV2(db: SyncDatabase): boolean {
  return (
    tableExists(db, 'session_v2') &&
    columnExists(db, 'session_v2', 'directory') &&
    columnExists(db, 'session_v2', 'time_created')
  )
}

/**
 * Sessions newer than `cursor`, oldest first. The composite
 * `(time_created, id)` position means rows sharing a millisecond with the
 * cursor — including rows the LIMIT cut off last round — are re-listed
 * instead of permanently skipped. Unknown shapes read as empty so an opencode
 * schema move degrades to unbound sessions, never a crash. Fail-open [] on
 * any read error for the same reason.
 */
export function listOpenCodeDbSessions(
  dbPath: string,
  cursor: OpenCodeSessionCursor
): BinderSessionRow[] {
  try {
    return readOpenCodeDatabase({
      dbPath,
      read: (db) => {
        const table = canReadSessionV2(db) ? 'session_v2' : 'session'
        if (
          !tableExists(db, table) ||
          !columnExists(db, table, 'directory') ||
          !columnExists(db, table, 'time_created')
        ) {
          return []
        }
        const parent = columnExists(db, table, 'parent_id') ? 'parent_id' : 'NULL'
        const rows: unknown[] = db
          .prepare(
            `SELECT id, directory, time_created, ${parent} AS parent_id FROM ${table} WHERE time_created > ? OR (time_created = ? AND id > ?) ORDER BY time_created ASC, id ASC LIMIT 500`
          )
          .all(cursor.ms, cursor.ms, cursor.id)
        const sessions: BinderSessionRow[] = []
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) {
            continue
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:sqlite returns plain row objects; the object check above plus the per-field validation below reject anything else.
          const record = row as Record<string, unknown>
          if (
            typeof record.id !== 'string' ||
            typeof record.directory !== 'string' ||
            typeof record.time_created !== 'number'
          ) {
            continue
          }
          sessions.push({
            id: record.id,
            directory: record.directory,
            createdAtMs: record.time_created,
            parentId: typeof record.parent_id === 'string' ? record.parent_id : null
          })
        }
        return sessions
      }
    })
  } catch (err) {
    console.warn('[opencode-binder] session store read failed; skipping round', err)
    return []
  }
}

/** Default database path for the local shared server. */
export function defaultOpenCodeDbPath(): string {
  return `${resolveOpenCodeDataDirectory()}/opencode.db`
}

/**
 * Live local panes from the PTY registry: pane key, worktree root and shell
 * pid. Panes without a key or pid (hydrated gaps, remote panes) cannot own a
 * client subtree, so they are skipped — their sessions stay unbound rather
 * than guessed.
 */
export function listBinderPaneSnapshots(): BinderPaneSnapshot[] {
  const snapshots: BinderPaneSnapshot[] = []
  for (const pty of listRegisteredPtys()) {
    if (!pty.paneKey || pty.pid === null) {
      continue
    }
    const parsed = pty.worktreeId ? splitWorktreeIdForFilesystem(pty.worktreeId) : null
    snapshots.push({
      paneKey: pty.paneKey,
      directory: parsed?.worktreePath ?? null,
      worktreeId: pty.worktreeId,
      shellPid: pty.pid,
      lastInputAtMs: pty.lastInputAtMs ?? null
    })
  }
  return snapshots
}

/** Apply one round's decisions to the listener registry. */
export function applyBinderOwnerships(
  state: HookListenerState,
  panes: readonly BinderPaneSnapshot[],
  ownerships: readonly SessionOwnership[],
  nowMs: number
): number {
  const worktreeByPane = new Map<string, string | null>()
  for (const pane of panes) {
    // Why overwrite: matching the round's newest-wins pane dedupe, so a
    // remint's live row wins over a stale row with a different worktree.
    worktreeByPane.set(pane.paneKey, pane.worktreeId)
  }
  let applied = 0
  for (const ownership of ownerships) {
    const binding: OpenCodeSessionBinding = {
      paneKey: ownership.paneKey,
      boundAt: nowMs,
      basis: ownership.basis
    }
    const worktreeId = worktreeByPane.get(ownership.paneKey)
    if (worktreeId) {
      binding.worktreeId = worktreeId
    }
    if (bindOpenCodeSession(state, ownership.sessionId, binding)) {
      applied += 1
    }
  }
  return applied
}
