import { isDirectorResolutionFailure } from '../../../../src/shared/remote-runtime/relay/client/relay-director-fallback'
import { ReplacementAuthenticationTimeoutError } from './replacement-session-authentication'

/** The phone's director-class failures: the shared ones, plus a replacement session that went quiet. */
export function isPhoneDirectorResolutionFailure(error: Error): boolean {
  // Quiet after relay-auth means the assigned cell is slow; resolving it again only doubles the wait.
  if (error instanceof ReplacementAuthenticationTimeoutError) {
    return error.stage === null || error.stage === 'opening'
  }
  return isDirectorResolutionFailure(error)
}
