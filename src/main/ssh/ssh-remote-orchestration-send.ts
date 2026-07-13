import { RemoteCliArgumentError } from './ssh-remote-cli-argument-error'

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
  if ((type === 'worker_done' || type === 'heartbeat') && !explicit && !envHandle) {
    // Why: the fallback must not turn missing remote identity into the
    // synthetic "unknown" handle for lifecycle authority decisions.
    throw new RemoteCliArgumentError(
      'no_active_sender_terminal',
      'Could not determine the sender terminal for this orchestration command. ' +
        'Pass --from <terminal-handle> or run the command inside a live Orca terminal with ORCA_TERMINAL_HANDLE set.'
    )
  }
  return explicit ?? envHandle ?? 'unknown'
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
