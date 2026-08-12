import type { GrokAccountStatus } from '../../shared/rate-limit-types'
import { isGrokAccessTokenFresh, type GrokAuthReadResult } from '../rate-limits/grok-auth'

export function getGrokAccountStatus(readResult: GrokAuthReadResult): GrokAccountStatus {
  if (readResult.status === 'missing') {
    return {
      signedIn: false,
      email: null,
      teamId: null,
      tokenFresh: false,
      error: null
    }
  }
  if (readResult.status === 'error') {
    return {
      signedIn: false,
      email: null,
      teamId: null,
      tokenFresh: false,
      error: readResult.error
    }
  }
  const session = readResult.session
  return {
    signedIn: true,
    email: session.email,
    teamId: session.teamId,
    tokenFresh: isGrokAccessTokenFresh(session),
    error: null
  }
}
