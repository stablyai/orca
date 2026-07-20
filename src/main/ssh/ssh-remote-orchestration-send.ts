import { RemoteCliArgumentError } from './ssh-remote-cli-argument-error'
import { ORCHESTRATION_SENDER_CAPABILITY_ENV } from '../../shared/orchestration-sender-capability'

type RemoteFlags = Map<string, string | boolean>

export function hasRemoteLifecycleRejection(result: unknown): boolean {
  if (!result || typeof result !== 'object') {
    return false
  }
  const lifecycle = (result as { lifecycle?: unknown }).lifecycle
  return (
    lifecycle !== null &&
    typeof lifecycle === 'object' &&
    (lifecycle as { action?: unknown }).action === 'rejected'
  )
}

export function resolveRemoteOrchestrationSender(
  flags: RemoteFlags,
  env: Record<string, string>,
  type: string | undefined
): string {
  const explicit = optionalString(flags, 'from')
  const envHandle = env.ORCA_TERMINAL_HANDLE || undefined
  const isLifecycle = type === 'worker_done' || type === 'heartbeat'
  if (isLifecycle && (!envHandle || !env[ORCHESTRATION_SENDER_CAPABILITY_ENV])) {
    throw new RemoteCliArgumentError(
      'no_active_sender_terminal',
      'Could not authenticate the sender terminal for this orchestration lifecycle command. Run it inside the currently dispatched Orca terminal.'
    )
  }
  if (isLifecycle && explicit && explicit !== envHandle) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      'Lifecycle --from must exactly match the current authenticated Orca terminal handle.'
    )
  }
  return (isLifecycle ? envHandle : (explicit ?? envHandle)) ?? 'unknown'
}

export function resolveRemoteOrchestrationSenderCapability(
  env: Record<string, string>,
  type: string | undefined
): string | undefined {
  if (type !== 'worker_done' && type !== 'heartbeat') {
    return undefined
  }
  const capability = env[ORCHESTRATION_SENDER_CAPABILITY_ENV] || undefined
  if (!capability) {
    throw new RemoteCliArgumentError(
      'no_active_sender_terminal',
      'Could not authenticate the sender terminal for this orchestration lifecycle command. Run it inside the currently dispatched Orca terminal.'
    )
  }
  return capability
}

export function getRemoteOrchestrationPayload(flags: RemoteFlags): string | undefined {
  const rawPayload = optionalString(flags, 'payload')
  const taskId = optionalString(flags, 'task-id')
  const dispatchId = optionalString(flags, 'dispatch-id')
  const filesModified = optionalString(flags, 'files-modified')
  const reportPath = optionalString(flags, 'report-path')
  const phase = optionalString(flags, 'phase')
  const hasStructuredPayload = [taskId, dispatchId, filesModified, reportPath, phase].some(
    (value) => value !== undefined
  )
  if (!hasStructuredPayload) {
    return rawPayload
  }
  if (rawPayload !== undefined) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      'Use either --payload or structured payload flags, not both.'
    )
  }

  // Why: the fallback receives the same preamble commands as the full CLI;
  // preserving these flags keeps lifecycle payloads valid over broken installs.
  const payload: Record<string, string | string[]> = {}
  if (taskId) {
    payload.taskId = taskId
  }
  if (dispatchId) {
    payload.dispatchId = dispatchId
  }
  if (filesModified) {
    payload.filesModified = filesModified
      .split(',')
      .map((file) => file.trim())
      .filter(Boolean)
  }
  if (reportPath) {
    payload.reportPath = reportPath
  }
  if (phase) {
    payload.phase = phase
  }
  return JSON.stringify(payload)
}

function optionalString(flags: RemoteFlags, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
