import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { AntigravityAccountTarget } from '../../shared/antigravity-account-types'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import type { AntigravityNativeCredential } from './native-credential-codec'
import { createAntigravityHostCredentialBackend } from './native-credential-backend'
import {
  AntigravityAccountService,
  type AntigravityCredentialBackend
} from './native-account-service'
import { isSameAntigravityLogin } from './native-account-usage-reading'

let service: AntigravityAccountService | null = null
let credentialChangeListener: () => void = () => {}

export function setAntigravityNativeCredentialChangeListener(listener: () => void): void {
  credentialChangeListener = listener
}

// The first read is a baseline: what agy held before Orca looked is unknown.
// agy's own token refreshes keep the refresh token and must not discard the usage they produce;
// a new refresh token is a fresh sign-in, even to the same account, and must clear a sign-in hold.
function reportingCredentialChanges(
  backend: AntigravityCredentialBackend
): AntigravityCredentialBackend {
  let lastSeen: AntigravityNativeCredential | null | undefined
  return {
    ...backend,
    async read() {
      const current = await backend.read()
      if (
        current &&
        lastSeen !== undefined &&
        (lastSeen === null ||
          lastSeen.refreshToken !== current.refreshToken ||
          !isSameAntigravityLogin(lastSeen, current))
      ) {
        credentialChangeListener()
      }
      lastSeen = current
      return current
    }
  }
}

export function getAntigravityAccountVaultPath(): string {
  return join(getAppEnvironment().getPath('userData'), 'antigravity-accounts', 'vault')
}

export function getAntigravityAccountService(
  target: AntigravityAccountTarget
): AntigravityAccountService {
  if (target.runtime !== 'host' || target.wslDistro) {
    throw new Error(
      'Antigravity account management for a client-selected WSL distro is not supported yet. Use agy inside that distro; the host account was not changed.'
    )
  }
  const env = getAppEnvironment()
  if (!service) {
    const backend = reportingCredentialChanges(
      createAntigravityHostCredentialBackend(env.getPath('home'))
    )
    service = new AntigravityAccountService(
      createEncryptedAntigravityAccountStore(getAntigravityAccountVaultPath(), backend.parse),
      backend
    )
  }
  return service
}
