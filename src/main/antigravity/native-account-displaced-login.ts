import { createHash } from 'node:crypto'
import type { AntigravityNativeCredential } from './native-credential-codec'
import {
  MAX_DISPLACED_LOGINS,
  type AntigravityAccountVault,
  type DisplacedAntigravityLogin
} from './native-account-store'

export function rememberDisplacedAntigravityLogin(
  vault: AntigravityAccountVault,
  current: AntigravityNativeCredential,
  subject?: string | null
): void {
  const identitySubject = current.identity?.subject ?? subject
  const displaced: DisplacedAntigravityLogin = {
    authMethod: current.authMethod,
    subjectSha256: identitySubject
      ? createHash('sha256').update(identitySubject).digest('hex')
      : null,
    refreshTokenSha256: current.refreshToken
      ? createHash('sha256').update(current.refreshToken).digest('hex')
      : null
  }
  if (!displaced.subjectSha256 && !displaced.refreshTokenSha256) {
    return
  }
  const prior = vault.displacedLogins ?? []
  vault.displacedLogins = [
    ...prior.filter((entry) => !displacedAntigravityLoginMatches(entry, current)),
    displaced
  ].slice(-MAX_DISPLACED_LOGINS)
}

export function displacedAntigravityLoginMatches(
  displaced: DisplacedAntigravityLogin,
  current: AntigravityNativeCredential
): boolean {
  if (displaced.authMethod !== current.authMethod) {
    return false
  }
  if (
    displaced.subjectSha256 &&
    current.identity?.subject &&
    displaced.subjectSha256 === createHash('sha256').update(current.identity.subject).digest('hex')
  ) {
    return true
  }
  return Boolean(
    displaced.refreshTokenSha256 &&
    current.refreshToken &&
    displaced.refreshTokenSha256 === createHash('sha256').update(current.refreshToken).digest('hex')
  )
}
