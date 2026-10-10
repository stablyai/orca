import type { ExecutionHostId } from '../../../src/shared/execution-host'
import {
  getExecutionHostHealthLabel,
  getSshConnectionHealth,
  type ExecutionHostHealth
} from '../../../src/shared/execution-host-health'
import { sshTargetSummaryHostId } from '../../../src/shared/worktree/host-context-labels'
import { isSshConnectionStatus } from '../transport/ssh-connection-status-arms'

/**
 * Health per SSH host, derived exactly as the desktop sidebar derives it. A desktop that predates
 * `connected` reports no lifecycle, and an unknown status is no verdict: both leave the host out.
 */
export function buildSshHostHealthById(
  sshTargets: readonly { id: string; connected?: boolean; connectionStatus?: string }[]
): Map<ExecutionHostId, ExecutionHostHealth> {
  const health = new Map<ExecutionHostId, ExecutionHostHealth>()
  for (const target of sshTargets) {
    const status = target.connectionStatus
    if (
      target.connected === undefined ||
      (status !== undefined && !isSshConnectionStatus(status))
    ) {
      continue
    }
    health.set(sshTargetSummaryHostId(target.id), getSshConnectionHealth(status))
  }
  return health
}

/** The word a row's host badge adds; a healthy or local host keeps the bare name. */
export function getHostHealthBadgeLabel(
  health: ExecutionHostHealth | undefined
): string | undefined {
  if (health === undefined || health === 'local' || health === 'available') {
    return undefined
  }
  return getExecutionHostHealthLabel(health)
}
