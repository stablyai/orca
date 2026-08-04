import type { GrokAccountIdentity, GrokAccountStatus } from '../../shared/rate-limit-types'
import { isGrokAccessTokenFresh } from '../rate-limits/grok-auth'
import { getGrokAuthSnapshot } from '../rate-limits/grok-auth-snapshot'

export function getGrokAccountStatus(): GrokAccountStatus {
  const snapshot = getGrokAuthSnapshot()
  const session = snapshot.value
  const value: GrokAccountIdentity | null = session
    ? {
        signedIn: true,
        email: session.email,
        teamId: session.teamId,
        tokenFresh: isGrokAccessTokenFresh(session)
      }
    : null
  return {
    ...snapshot,
    value,
    signedIn: value?.signedIn ?? false,
    email: value?.email ?? null,
    teamId: value?.teamId ?? null,
    tokenFresh: value?.tokenFresh ?? false,
    error:
      snapshot.availability === 'denied'
        ? 'Grok auth file access was denied'
        : snapshot.availability === 'unavailable'
          ? 'Unable to read Grok auth file'
          : null
  }
}
