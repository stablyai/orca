import { ARTIFACT_CLI_REQUEST_TIMEOUT_MS } from '../../../shared/artifacts/artifacts'

/** The desktop may wait once on an artifact API rate limit before replaying, so allow for it. */
export function artifactMethodTimeoutMs(method: string): number {
  return method.startsWith('artifacts.') ? ARTIFACT_CLI_REQUEST_TIMEOUT_MS : 0
}
