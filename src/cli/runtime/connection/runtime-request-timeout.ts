import { ARTIFACT_CLI_REQUEST_TIMEOUT_MS } from '../../../shared/artifacts/artifacts'

export function isWaitingCheck(params: unknown): boolean {
  return (
    typeof params === 'object' &&
    params !== null &&
    'wait' in params &&
    (params as { wait: unknown }).wait === true
  )
}

export function getTimeoutMsParam(params: unknown): unknown {
  if (typeof params !== 'object' || params === null || !('timeoutMs' in params)) {
    return undefined
  }
  return (params as { timeoutMs?: unknown }).timeoutMs
}

/** The desktop may wait once on an artifact API rate limit before replaying, so allow for it. */
export function artifactMethodTimeoutMs(method: string): number {
  return method.startsWith('artifacts.') ? ARTIFACT_CLI_REQUEST_TIMEOUT_MS : 0
}
