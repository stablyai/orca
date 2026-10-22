import type { MuseAccountStatus } from '../../shared/rate-limit-types'
import { readMuseAuthSession } from './auth'

export function getMuseAccountStatus(authPath?: string): MuseAccountStatus {
  const readResult = authPath ? readMuseAuthSession(authPath) : readMuseAuthSession()
  if (readResult.status === 'missing') {
    return {
      signedIn: false,
      email: null,
      fullName: null,
      subscriptionActive: null,
      obtainedVia: null,
      error: null
    }
  }
  if (readResult.status === 'error') {
    return {
      signedIn: false,
      email: null,
      fullName: null,
      subscriptionActive: null,
      obtainedVia: null,
      error: readResult.error
    }
  }
  const session = readResult.session
  return {
    signedIn: true,
    email: session.email,
    fullName: session.fullName,
    subscriptionActive: session.subscriptionActive,
    obtainedVia: session.obtainedVia,
    error: null
  }
}
