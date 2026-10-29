import { parseExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import type { Worktree } from './workspace-list-types'

// Kept free of storage and React Native: the e2e phone-list helper builds sections through this.

export type LastVisitedWorktreeOnHost = {
  worktreeId: string
  /** A server workspace's `runtime:` host; absent for the desktop's own (local and SSH) rows. */
  executionHost?: ExecutionHostId
}

export function routeExecutionHostOf(
  hostId: string | null | undefined
): ExecutionHostId | undefined {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime' ? parsed.id : undefined
}

// Highlight this phone’s last-opened row only; desktop selection must not stand in for mobile history.
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
