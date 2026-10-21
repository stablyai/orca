import { parseExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import type { Worktree } from './workspace-list-types'

// Kept free of storage and React Native: the e2e phone-list helper builds sections through this.

/** The workspace this phone last opened on one paired host: the session route's own params. */
export type LastVisitedWorktreeOnHost = {
  worktreeId: string
  /** A server workspace's `runtime:` host; absent for the desktop's own (local and SSH) rows. */
  executionHost?: ExecutionHostId
}

/** The route's server for a row, as the host list routes it: only a `runtime:` host is named. */
export function routeExecutionHostOf(
  hostId: string | null | undefined
): ExecutionHostId | undefined {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime' ? parsed.id : undefined
}

/**
 * Whether `row` is the workspace this phone last opened on its host: the host list's only highlight.
 * The desktop's selection never stands in, so a hidden or never-opened row leaves nothing lit.
 */
export function isLastVisitedWorktreeRow(
  row: Pick<Worktree, 'worktreeId' | 'hostId'>,
  visited: LastVisitedWorktreeOnHost | null
): boolean {
  return (
    visited !== null &&
    row.worktreeId === visited.worktreeId &&
    routeExecutionHostOf(row.hostId) === visited.executionHost
  )
}
