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
import type {
  BinderSessionRow,
  OpenCodeSessionCursor
} from '../foreign-sqlite-readers/opencode-binder-sessions-result'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { listRegisteredPtys } from '../memory/pty-registry'
import { isOpenCodeClientProcess, type ProcessIdentityRow } from './opencode-client-sweep'
import type { HookListenerState } from '../../shared/agent-hook-listener/listener-state'

// Bind shared OpenCode 1 serve/attach sessions to panes; database reads run in a foreign-SQLite worker.

export type BinderPaneSnapshot = {
  paneKey: string
  /** Sessions beneath this root are candidates; null means unknown. */
  directory: string | null
  worktreeId: string | null
  shellPid: number | null
}

export type BinderRoundDeps = {
  nowMs: number
  sessions: readonly BinderSessionRow[]
  panes: readonly BinderPaneSnapshot[]
  processes: readonly ProcessIdentityRow[]
  knownOwners: ReadonlyMap<string, string>
  parentBySessionId: ReadonlyMap<string, string | null>
}

export type BinderRoundResult = {
  ownerships: SessionOwnership[]
}

export const OPENCODE_SESSION_CURSOR_START: OpenCodeSessionCursor = { ms: 0, id: '' }

function compareSessionRows(left: OpenCodeSessionCursor, right: OpenCodeSessionCursor): number {
  return left.ms - right.ms || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

/** Freeze at the first unhandled row so capped tails are listed again next round. */
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

function childrenIndex(processes: readonly ProcessIdentityRow[]): Map<number, number> {
  const ppidByPid = new Map<number, number>()
  for (const row of processes) {
    if (!ppidByPid.has(row.pid)) {
      ppidByPid.set(row.pid, row.ppid)
    }
  }
  return ppidByPid
}

/** Leave external terminals unattributed. */
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
    // Bracket session creation between process start and this live observation.
    clients.push({ paneKey, startedAtMs: row.startedAtMs, lastSeenAliveMs: nowMs, argv: row.argv })
  }
  return clients
}

export function runOpenCodeBinderRound(deps: BinderRoundDeps): BinderRoundResult {
  // Remints can leave stale rows: deduplicate by pane with newest ownership to avoid
  // false ambiguity or attribution to an old worktree.
  const paneByKey = new Map<string, CorrelatedPane>()
  for (const pane of deps.panes) {
    paneByKey.set(pane.paneKey, { paneKey: pane.paneKey, directory: pane.directory })
  }
  const panes = [...paneByKey.values()]
  const clients = toCorrelatedClients(deps.processes, deps.panes, deps.nowMs)
  const sessions: CorrelatedSession[] = deps.sessions.map((row) => ({
    id: row.id,
    directory: row.directory,
    createdAtMs: row.createdAtMs,
    parentId: row.parentId
  }))
  // New-row-only reads omit older roots; resolve known ancestor ownership before correlation
  // and emit inherited binds so the registry also learns them.
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

export function defaultOpenCodeDbPath(): string {
  return `${resolveOpenCodeDataDirectory()}/opencode.db`
}

/** Skip panes without keys or shell PIDs; guessing would misattribute remote/hydration gaps. */
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
      shellPid: pty.pid
    })
  }
  return snapshots
}

export function applyBinderOwnerships(
  state: HookListenerState,
  panes: readonly BinderPaneSnapshot[],
  ownerships: readonly SessionOwnership[],
  nowMs: number
): number {
  const worktreeByPane = new Map<string, string | null>()
  for (const pane of panes) {
    // Match the round’s newest-wins deduplication for reminted panes.
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
