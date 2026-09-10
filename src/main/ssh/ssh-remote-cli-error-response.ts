import { RemoteCliArgumentError } from './ssh-remote-cli-argument-error'
import type { RemoteOrcaCliResult } from './ssh-remote-cli-host-passthrough'
import type { RpcResponse } from '../runtime/rpc/core'

export function buildRemoteCliError(message: string, code = 'runtime_error'): RpcResponse {
  return {
    id: 'remote-cli-local',
    ok: false,
    error: { code, message },
    _meta: { runtimeId: 'unknown' }
  }
}

export function buildRemoteCliFailure(
  err: unknown,
  json: boolean,
  command: string
): RemoteOrcaCliResult {
  if (command === 'linear list-issues' && !(err instanceof RemoteCliArgumentError)) {
    throw new Error(
      'Linear listing could not be delivered; retry the input position or restart concrete workspaces and reconcile by issue ID.'
    )
  }
  const rawMessage = err instanceof Error ? err.message : String(err)
  const message =
    command === 'linear list-issues' && Buffer.byteLength(rawMessage) > 512
      ? 'Invalid Linear listing arguments; retry with a bounded request.'
      : rawMessage
  const code =
    err instanceof RemoteCliArgumentError
      ? err.code
      : err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'runtime_error'
  if (json) {
    return {
      stdout: `${JSON.stringify(buildRemoteCliError(message, code), null, 2)}\n`,
      stderr: '',
      exitCode: 1
    }
  }
  return { stdout: '', stderr: `${message}\n`, exitCode: 1 }
}
