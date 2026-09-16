import type { AntigravityAccountStatus } from '../../shared/rate-limit-types'
import {
  isAntigravitySessionUsable,
  readAntigravityAuthSession
} from '../rate-limits/antigravity-oauth-sources'

export function getAntigravityAccountStatus(): AntigravityAccountStatus {
  const readResult = readAntigravityAuthSession()
  if (readResult.status === 'missing') {
    return {
      signedIn: false,
      email: null,
      tokenFresh: false,
      error: null
    }
  }
  if (readResult.status === 'error') {
    return {
      signedIn: false,
      email: null,
      tokenFresh: false,
      error: readResult.error
    }
  }
  return {
    signedIn: true,
    email: readResult.session.email,
    tokenFresh: isAntigravitySessionUsable(readResult.session),
    error: null
  }
}
