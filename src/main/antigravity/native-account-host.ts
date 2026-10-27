import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { AntigravityAccountTarget } from '../../shared/antigravity-account-types'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { createAntigravityHostCredentialBackend } from './native-credential-backend'
import {
  AntigravityAccountService,
  type AntigravityCredentialBackend
} from './native-account-service'

let service: AntigravityAccountService | null = null
let credentialChangeListener: () => void = () => {}

export function setAntigravityNativeCredentialChangeListener(listener: () => void): void {
  credentialChangeListener = listener
}

// The first read is a baseline: what agy held before Orca looked is unknown.
function reportingCredentialChanges(
  backend: AntigravityCredentialBackend
): AntigravityCredentialBackend {
  let lastSeen: string | null | undefined
  return {
    ...backend,
    async read() {
      const current = await backend.read()
      const contents = current?.contents ?? null
      if (contents !== null && lastSeen !== undefined && lastSeen !== contents) {
        credentialChangeListener()
      }
      lastSeen = contents
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
  service ??= new AntigravityAccountService(
    createEncryptedAntigravityAccountStore(getAntigravityAccountVaultPath()),
    reportingCredentialChanges(createAntigravityHostCredentialBackend(env.getPath('home')))
  )
  return service
}
