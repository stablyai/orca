// EP-8: can this computer reach an Orca Cloud workspace's server right now? A short status call over
// its saved pairing. A refused pairing (revoked by an owner change or a removal) is told apart from a
// server that just doesn't answer, so the caller can say which.
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'

const PROBE_TIMEOUT_MS = 5_000
const REJECTED_CODES = new Set(['unauthorized', 'device_revoked', 'forbidden'])

export function classifyProbeFailure(
  code: string | undefined,
  message: string
): 'rejected' | 'no_answer' {
  return (code && REJECTED_CODES.has(code)) || /rejected the pairing token/i.test(message)
    ? 'rejected'
    : 'no_answer'
}

export async function probeCloudServer(
  userDataPath: string,
  environmentId: string,
  call: typeof callRuntimeEnvironment = callRuntimeEnvironment
): Promise<'ok' | 'rejected' | 'no_answer'> {
  if (!environmentId) {
    return 'no_answer'
  }
  try {
    const response = await call(
      userDataPath,
      environmentId,
      'status.get',
      undefined,
      PROBE_TIMEOUT_MS
    )
    return response.ok
      ? 'ok'
      : classifyProbeFailure(response.error?.code, response.error?.message ?? '')
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined
    return classifyProbeFailure(code, error instanceof Error ? error.message : String(error))
  }
}
