import {
  isRuntimeOwnedSshTargetId,
  RUNTIME_OWNED_SSH_TARGET_ID_PREFIX,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import { getPtyExecutionHost } from '../../../shared/terminal-execution-host'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { OrchestrationError } from '../orchestration/orchestration-error'
import { readStoredMaestroProjection } from '../orchestration/db/maestro/maestro-projection-persistence'
import type { OrchestrationCompatibilityTerminalAuthority } from '../orca-runtime'
import type { RpcContext } from './core'

export type ResolvedMaestroWorkspace = {
  repository_id: string | null
  execution_host_id: string
  workspace_key: string
}

function terminalWorkspaceKey(worktreeId: string): string {
  return parseWorkspaceKey(worktreeId) ? worktreeId : worktreeWorkspaceKey(worktreeId)
}

function runtimeOwnedSshHostIds(targetId: string): string[] {
  if (!isRuntimeOwnedSshTargetId(targetId)) {
    return [toSshExecutionHostId(targetId)]
  }
  const runtimeId = targetId.slice(RUNTIME_OWNED_SSH_TARGET_ID_PREFIX.length)
  return runtimeId
    ? [toSshExecutionHostId(targetId), toRuntimeExecutionHostId(runtimeId)]
    : [toSshExecutionHostId(targetId)]
}

function terminalExecutionHostIds(terminal: OrchestrationCompatibilityTerminalAuthority): string[] {
  const ptyHost = getPtyExecutionHost(terminal.ptyId)
  if (ptyHost === 'foreign') {
    return []
  }
  if (ptyHost?.startsWith('ssh:')) {
    const parsedTargetId = decodeURIComponent(ptyHost.slice('ssh:'.length))
    return runtimeOwnedSshHostIds(parsedTargetId)
  }
  if (ptyHost) {
    return [ptyHost]
  }
  return terminal.hostScope.kind === 'ssh'
    ? runtimeOwnedSshHostIds(terminal.hostScope.targetId)
    : ['local']
}

export function terminalMatchesMaestroWorkspace(
  context: RpcContext,
  terminal: OrchestrationCompatibilityTerminalAuthority,
  resolved: ResolvedMaestroWorkspace,
  runId: string,
  currentCoordinator: boolean
): boolean {
  const terminalHostIds = terminalExecutionHostIds(terminal)
  const terminalWorkspace = terminalWorkspaceKey(terminal.worktreeId)
  if (
    terminalHostIds.includes(resolved.execution_host_id) &&
    terminalWorkspace === resolved.workspace_key
  ) {
    return true
  }
  if (!currentCoordinator) {
    return false
  }
  const projection = readStoredMaestroProjection(
    context.runtime.getOrchestrationDb(),
    {
      execution_host_id: resolved.execution_host_id,
      workspace_key: resolved.workspace_key
    },
    runId
  )
  const home = projection?.view.workspace_scope.orchestration_home
  return Boolean(
    home &&
    terminalHostIds.includes(home.execution_host_id) &&
    terminalWorkspace === home.workspace_key
  )
}

export function maestroWorkspaceAuthorityMismatch(
  terminal: OrchestrationCompatibilityTerminalAuthority,
  resolved: ResolvedMaestroWorkspace
): OrchestrationError {
  return new OrchestrationError(
    'unauthorized',
    `The authenticated terminal is bound to workspace ${terminalWorkspaceKey(terminal.worktreeId)}, not requested workspace ${resolved.workspace_key}.`,
    {
      requested: {
        executionHostId: resolved.execution_host_id,
        workspaceKey: resolved.workspace_key
      },
      caller: {
        executionHostIds: terminalExecutionHostIds(terminal),
        workspaceKey: terminalWorkspaceKey(terminal.worktreeId)
      }
    }
  )
}
