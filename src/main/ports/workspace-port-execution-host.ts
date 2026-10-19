import {
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type {
  WorkspacePortHostKillRequest,
  WorkspacePortHostScanResult,
  WorkspacePortKillResult,
  WorkspacePortProbe
} from '../../shared/workspace-ports'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../providers/ssh-host-not-served-error'
import { killWorkspacePort, scanWorkspacePortProbes } from './workspace-port-ownership'

export type WorkspacePortExecutionHostDeps = {
  /** Workspaces this host runs itself; the only processes Stop may signal here. */
  getLocalProbes: () => Promise<WorkspacePortProbe[]>
}

function unavailable(executionHostId: string, reason: string): WorkspacePortHostScanResult {
  return {
    executionHostId,
    platform: 'unknown',
    scannedAt: Date.now(),
    ports: [],
    unavailableReason: reason
  }
}

/** Scans the execution host a workspace resolved to on this endpoint, and names it on the result. */
export async function scanWorkspacePortsOnExecutionHost(
  executionHostId: ExecutionHostId,
  deps: WorkspacePortExecutionHostDeps
): Promise<WorkspacePortHostScanResult> {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind === 'local') {
    return { ...(await scanWorkspacePortProbes(await deps.getLocalProbes())), executionHostId }
  }
  // Why: this process serves no SSH host, so its listeners are unavailable, never "none".
  if (host?.kind === 'ssh') {
    return unavailable(
      executionHostId,
      `Could not scan the SSH host: ${SSH_HOST_NOT_SERVED_MESSAGE}`
    )
  }
  return unavailable(executionHostId, 'This workspace does not run on this server.')
}

/**
 * Stops a listener only on the host the workspace resolves to now, and only when that is also the
 * host the row was scanned on, so a row from one machine can never signal a same-numbered pid on
 * another.
 */
export async function killWorkspacePortOnExecutionHost(
  resolvedHostId: ExecutionHostId,
  request: Omit<WorkspacePortHostKillRequest, 'worktree'>,
  deps: WorkspacePortExecutionHostDeps
): Promise<WorkspacePortKillResult> {
  if (normalizeExecutionHostId(request.executionHostId) !== resolvedHostId) {
    return {
      ok: false,
      reason: 'This port was found on a different host than the workspace runs on. Rescan first.'
    }
  }
  const host = parseExecutionHostId(resolvedHostId)
  if (host?.kind === 'local') {
    return killWorkspacePort(await deps.getLocalProbes(), { pid: request.pid, port: request.port })
  }
  // Why: the relay can neither attribute a listener to a workspace nor signal it, so ownership
  // cannot be proven on the SSH host; refusing keeps Stop from ever acting on the wrong machine.
  if (host?.kind === 'ssh') {
    return { ok: false, reason: 'Stopping processes on an SSH host is not supported yet.' }
  }
  return { ok: false, reason: 'This workspace does not run on this server.' }
}
