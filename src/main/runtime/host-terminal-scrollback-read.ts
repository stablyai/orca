import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { SessionReadTerminalScrollbackResult } from '../../shared/rpc-contract/session-terminal-scrollback-params'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../shared/terminal-scrollback-limits'

export type HostTerminalScrollbackReadDeps = {
  /** Resolves the caller's worktree selector the way every workspace method does; throws when unknown. */
  resolveWorktreeId: (selector: string) => Promise<string>
  getWorkspaceSession: (worktreeId: string) => WorkspaceSessionState | null
  /** Byte size of the stored file, checked before any bytes are read; null when absent. */
  statSnapshotSize: (ref: string) => Promise<number | null>
  readSnapshot: (ref: string) => Promise<string | null>
}

export type HostTerminalScrollbackReadRequest = {
  worktree: string
  ref: string
}

function worktreeSessionNamesScrollbackRef(
  session: WorkspaceSessionState,
  worktreeId: string,
  ref: string
): boolean {
  return (session.tabsByWorktree[worktreeId] ?? []).some((tab) =>
    Object.values(session.terminalLayoutsByTabId[tab.id]?.scrollbackRefsByLeafId ?? {}).includes(
      ref
    )
  )
}

/**
 * The stored scrollback for a pane of a worktree this host serves. A ref no tab of that worktree
 * names answers not-found, the same as a missing file, so a caller cannot probe other workspaces.
 */
export async function readHostTerminalScrollback(
  deps: HostTerminalScrollbackReadDeps,
  request: HostTerminalScrollbackReadRequest
): Promise<SessionReadTerminalScrollbackResult> {
  const worktreeId = await deps.resolveWorktreeId(request.worktree)
  const session = deps.getWorkspaceSession(worktreeId)
  if (!session || !worktreeSessionNamesScrollbackRef(session, worktreeId, request.ref)) {
    throw new Error('terminal_scrollback_not_found')
  }
  const size = await deps.statSnapshotSize(request.ref)
  if (size === null || size <= 0) {
    throw new Error('terminal_scrollback_not_found')
  }
  // Why: refuse a file no store write could have produced before reading any of it.
  if (size > TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT) {
    throw new Error('terminal_scrollback_too_large')
  }
  const buffer = await deps.readSnapshot(request.ref)
  if (!buffer) {
    throw new Error('terminal_scrollback_not_found')
  }
  return { buffer }
}
