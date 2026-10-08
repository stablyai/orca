import type { GlobalSettings } from '../../shared/global-settings-types'
import type { CursorAccountStatus } from '../../shared/rate-limit-types'
import { readCursorAuthSession } from '../rate-limits/cursor-auth'
import { isCursorSessionTokenExpired } from '../rate-limits/cursor-session-token'

function signedOut(error: string | null): CursorAccountStatus {
  return {
    signedIn: false,
    email: null,
    displayName: null,
    credentialSource: null,
    planType: null,
    tokenFresh: false,
    error
  }
}

export async function getCursorAccountStatus(
  settings:
    | Pick<GlobalSettings, 'automaticallyDetectAiAccounts'>
    | (() => Pick<GlobalSettings, 'automaticallyDetectAiAccounts'>)
): Promise<CursorAccountStatus> {
  const detectionEnabled = () =>
    (typeof settings === 'function' ? settings() : settings).automaticallyDetectAiAccounts !== false
  if (!detectionEnabled()) {
    return signedOut(null)
  }
  const readResult = await readCursorAuthSession()
  if (!detectionEnabled()) {
    return signedOut(null)
  }
  if (readResult.status !== 'ok') {
    return signedOut(readResult.status === 'error' ? readResult.error : null)
  }
  const session = readResult.session
  return {
    signedIn: true,
    email: session.email,
    displayName: session.displayName,
    credentialSource: session.source,
    planType: session.membershipType,
    tokenFresh: !isCursorSessionTokenExpired(session.token),
    error: null
  }
}
