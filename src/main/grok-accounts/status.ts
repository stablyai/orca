import type { GlobalSettings } from '../../shared/global-settings-types'
import type { GrokAccountStatus } from '../../shared/rate-limit-types'
import { isGrokAccessTokenFresh, readGrokAuthSession } from '../rate-limits/grok-auth'

export function getGrokAccountStatus(
  settings: Pick<GlobalSettings, 'automaticallyDetectAiAccounts'>
): GrokAccountStatus {
  if (settings.automaticallyDetectAiAccounts === false) {
    return {
      signedIn: false,
      email: null,
      teamId: null,
      tokenFresh: false,
      error: null
    }
  }
  const readResult = readGrokAuthSession()
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
