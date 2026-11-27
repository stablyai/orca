import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import type { AntigravityAccountTarget } from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { createAntigravityHostCredentialBackend } from './native-credential-backend'
import { createAntigravityWslCredentialBackend } from './native-wsl-credentials'
import { resolveWslDefaultDistro } from '../wsl/discovery/wsl-default-distro'
import {
  AntigravityAccountService,
  type AntigravityCredentialBackend,
  type AntigravityLaunchRestore
} from './native-account-service'
import { antigravitySignInHoldsNativeLogin } from './antigravity-chat-sign-in'

let service: AntigravityAccountService | null = null
const wslServices = new Map<string, AntigravityAccountService>()

export function getAntigravityAccountVaultPath(wslDistro?: string): string {
  const root = join(getAppEnvironment().getPath('userData'), 'antigravity-accounts')
  // Each distro keeps its own saved accounts, matching its own agy login.
  return wslDistro
    ? join(root, `wsl-${encodeURIComponent(wslDistro.trim().toLowerCase())}`, 'vault')
    : join(root, 'vault')
}

function createService(
  backend: AntigravityCredentialBackend,
  vaultPath: string,
  launchRestore?: AntigravityLaunchRestore
) {
  return new AntigravityAccountService(
    createEncryptedAntigravityAccountStore(vaultPath, backend.parse),
    backend,
    undefined,
    undefined,
    launchRestore
  )
}

async function resolveWslAccountDistro(wslDistro: string | null | undefined): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('Antigravity accounts in a WSL distro are only available on Windows.')
  }
  const distro = wslDistro?.trim() || (await resolveWslDefaultDistro())
  if (typeof distro !== 'string' || !distro) {
    throw new Error('Orca could not determine the default WSL distro for Antigravity accounts.')
  }
  return distro
}

export async function getAntigravityAccountService(
  target: AntigravityAccountTarget
): Promise<AntigravityAccountService> {
  if (target.runtime === 'wsl') {
    const distro = await resolveWslAccountDistro(target.wslDistro)
    const key = distro.toLowerCase()
    let wslService = wslServices.get(key)
    if (!wslService) {
      wslService = createService(
        createAntigravityWslCredentialBackend(distro),
        getAntigravityAccountVaultPath(distro)
      )
      wslServices.set(key, wslService)
    }
    return wslService
  }
  if (target.wslDistro) {
    throw new Error('An Antigravity host account target cannot name a WSL distro.')
  }
  service ??= createService(
    createAntigravityHostCredentialBackend(getAppEnvironment().getPath('home')),
    getAntigravityAccountVaultPath(),
    // Windows launches aren't gated (native-account-launch.ts), so nothing restores there.
    process.platform === 'win32'
      ? undefined
      : { signInHoldsLogin: antigravitySignInHoldsNativeLogin }
  )
  return service
}
