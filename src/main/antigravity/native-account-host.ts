import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { AntigravityAccountTarget } from '../../shared/antigravity-account-types'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { createAntigravityHostCredentialBackend } from './native-credential-backend'
import { AntigravityAccountService } from './native-account-service'

let service: AntigravityAccountService | null = null

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
    createAntigravityHostCredentialBackend(env.getPath('home'))
  )
  return service
}
