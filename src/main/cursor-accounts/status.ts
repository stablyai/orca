import type { CursorAccountStatus } from '../../shared/rate-limit-types'
import { isCursorAccessTokenFresh, readCursorAuthSession } from '../rate-limits/cursor-auth'

export function getCursorAccountStatus(): CursorAccountStatus {
  const readResult = readCursorAuthSession()
  if (readResult.status === 'missing') {
    return {
      signedIn: false,
      email: null,
      userId: null,
      tokenFresh: false,
      error: null
    }
  }
  if (readResult.status === 'error') {
    return {
      signedIn: false,
      email: null,
      userId: null,
      tokenFresh: false,
      error: readResult.error
    }
  }
  const session = readResult.session
  return {
    signedIn: true,
    email: session.email,
    userId: session.userId,
    tokenFresh: isCursorAccessTokenFresh(session),
    error: null
  }
}
