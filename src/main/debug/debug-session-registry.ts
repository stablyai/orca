import type { DebugSession, DebugSessionState } from '../../shared/debug-session-types'
import type { DapClient } from './dap-client'
import type { DebugSessionStateMachine } from './debug-session-state-machine'

/**
 * Per-worktree scoping for live debug sessions, mirroring
 * `src/main/memory/pty-registry.ts`'s shape: two worktrees run fully
 * independent sessions, so the IPC layer looks sessions up by id but lists
 * and tears them down by worktree.
 */
export type DebugSessionRuntime = {
  session: DebugSession
  client: DapClient
  machine: DebugSessionStateMachine
}

const sessionsById = new Map<string, DebugSessionRuntime>()
const sessionIdsByWorktreeId = new Map<string, Set<string>>()

export function registerDebugSession(runtime: DebugSessionRuntime): void {
  sessionsById.set(runtime.session.id, runtime)
  const worktreeId = runtime.session.worktreeId
  let ids = sessionIdsByWorktreeId.get(worktreeId)
  if (!ids) {
    ids = new Set()
    sessionIdsByWorktreeId.set(worktreeId, ids)
  }
  ids.add(runtime.session.id)
}

export function unregisterDebugSession(sessionId: string): void {
  const runtime = sessionsById.get(sessionId)
  if (!runtime) {
    return
  }
  sessionsById.delete(sessionId)
  const ids = sessionIdsByWorktreeId.get(runtime.session.worktreeId)
  ids?.delete(sessionId)
  if (ids && ids.size === 0) {
    sessionIdsByWorktreeId.delete(runtime.session.worktreeId)
  }
}

export function getDebugSession(sessionId: string): DebugSessionRuntime | undefined {
  return sessionsById.get(sessionId)
}

export function listDebugSessionsForWorktree(worktreeId: string): DebugSessionRuntime[] {
  const ids = sessionIdsByWorktreeId.get(worktreeId)
  if (!ids) {
    return []
  }
  return [...ids]
    .map((id) => sessionsById.get(id))
    .filter((runtime): runtime is DebugSessionRuntime => runtime != null)
}

export function listAllDebugSessions(): DebugSessionRuntime[] {
  return [...sessionsById.values()]
}

/** Called as the state machine reports transitions, so registry snapshots (used by `listDebugSessionsForWorktree`) stay current without every caller re-deriving state from the live machine. */
export function updateDebugSessionState(sessionId: string, state: DebugSessionState): void {
  const runtime = sessionsById.get(sessionId)
  if (runtime) {
    runtime.session = { ...runtime.session, state }
  }
}
