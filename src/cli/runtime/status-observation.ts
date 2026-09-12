import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { sendRequest } from './transport'
import { validateStatusResult } from './status-result'
import { RuntimeClientError, RuntimeRpcFailureError } from './types'

export type ProcessObservation = 'live' | 'unverifiable' | 'exited'

export function observeLocalProcess(pid: number | null | undefined): ProcessObservation {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) {
    return 'unverifiable'
  }
  try {
    process.kill(pid, 0)
    return 'live'
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ESRCH' ? 'exited' : 'unverifiable'
  }
}

export function statusObservationError(
  process: ProcessObservation,
  error: unknown
): RuntimeClientError {
  return new RuntimeClientError(
    error instanceof RuntimeClientError ? error.code : 'runtime_unavailable',
    'Could not verify Orca runtime status. Process visibility does not establish startup or readiness. Check runtime access from this execution context before retrying.',
    {
      statusObservation: {
        version: 1,
        target: 'local',
        process,
        startup: 'unverifiable',
        runtime: 'unverifiable',
        ...(error instanceof RuntimeClientError ? { failure: { code: error.code } } : {})
      },
      ...(error instanceof RuntimeClientError &&
      !(error instanceof RuntimeRpcFailureError) &&
      error.data &&
      typeof error.data === 'object' &&
      'transportFailure' in error.data
        ? { transportFailure: error.data.transportFailure }
        : {})
    }
  )
}

export function isStatusObservationError(error: unknown): error is RuntimeClientError {
  if (!(error instanceof RuntimeClientError) || !error.data || typeof error.data !== 'object') {
    return false
  }
  const observation = 'statusObservation' in error.data ? error.data.statusObservation : null
  return (
    !!observation &&
    typeof observation === 'object' &&
    'version' in observation &&
    observation.version === 1 &&
    'target' in observation &&
    observation.target === 'local'
  )
}

// A dead cached PID authorizes launch only when its endpoint also refused connection.
function isAbsentEndpoint(error: unknown): boolean {
  if (!(error instanceof RuntimeClientError) || error instanceof RuntimeRpcFailureError) {
    return false
  }
  const data = error.data
  if (!data || typeof data !== 'object' || !('transportFailure' in data)) {
    return false
  }
  const failure = data.transportFailure
  return (
    !!failure &&
    typeof failure === 'object' &&
    'outcome' in failure &&
    failure.outcome === 'socket_error' &&
    'connected' in failure &&
    failure.connected === false &&
    'code' in failure &&
    (failure.code === 'ENOENT' || failure.code === 'ECONNREFUSED')
  )
}

// Only failed connection establishment can combine with cached-process exit as absence.
export async function observeRuntimeStatus(
  metadata: RuntimeMetadata
): Promise<RuntimeStatus | null> {
  let response
  try {
    response = await sendRequest<RuntimeStatus>(metadata, 'status.get', undefined, 1000)
  } catch (error) {
    const process = observeLocalProcess(metadata.pid)
    if (process === 'exited' && isAbsentEndpoint(error)) {
      return null
    }
    throw statusObservationError(process, error)
  }
  try {
    if (response.ok === false) {
      throw new RuntimeRpcFailureError(response)
    }
    validateStatusResult(response.result, metadata.runtimeId)
    return response.result
  } catch (error) {
    throw statusObservationError(observeLocalProcess(metadata.pid), error)
  }
}
