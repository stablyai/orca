import type {
  CanvasContextBinding,
  CanvasContextIdentity
} from '../../../../shared/canvas-agent-context'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { agentHookServer } from '../../../agent-hooks/server'
import type { OrcaRuntimeService } from '../../orca-runtime'

export function resolveCanvasContextIdentity(
  runtime: OrcaRuntimeService,
  binding: CanvasContextBinding
): CanvasContextIdentity | null | 'unsupported' {
  const terminal = runtime.resolveTerminalPane(binding.paneKey, binding.worktreeId)
  if (
    terminal.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    !runtime.getClientSettings().agentStatusHooksEnabled ||
    runtime.getClientSettings().disabledTuiAgents.includes(binding.provider)
  ) {
    return 'unsupported'
  }
  if (
    terminal.ptyId !== binding.ptyId ||
    runtime.resolveLiveLeafForHandle(terminal.handle)?.ptyId !== binding.ptyId
  ) {
    throw new Error('The terminal session changed. Reconnect the note.')
  }
  const authority = agentHookServer
    .getCurrentAuthorityObservations()
    .find(
      (entry) =>
        entry.paneKey === binding.paneKey &&
        entry.connectionId === null &&
        entry.worktreeId === binding.worktreeId
    )
  const observed = agentHookServer.canvasContexts.identity(
    binding.paneKey,
    binding.provider,
    binding.worktreeId
  )
  const launch = runtime.getOrchestrationDispatchAuthority(terminal.handle)
  const launchTokenHash =
    launch?.ptyId === binding.ptyId && launch.worktreeId === binding.worktreeId
      ? (launch.launchTokenHash ?? authority?.launchTokenHash)
      : authority?.launchTokenHash
  return launchTokenHash
    ? {
        sessionId: observed?.launchTokenHash === launchTokenHash ? observed.sessionId : '',
        launchTokenHash
      }
    : null
}
