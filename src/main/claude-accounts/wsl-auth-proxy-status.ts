import { accessSync, constants } from 'node:fs'
import { savedWslClaudeAccountHome } from './claude-profile-wsl-paths'
import { toWindowsWslPath } from '../../shared/wsl-paths'

type WslAuthProxyAccount = {
  id: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxAuthPath?: string | null
}

/** The guest reads the same `.credentials.json` the Windows desktop can see over the distro UNC path. */
export function wslCredentialFileReadable(account: WslAuthProxyAccount): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  const home = savedWslClaudeAccountHome(account)
  const distro = account.wslDistro
  if (!home || !distro) {
    return false
  }
  try {
    accessSync(toWindowsWslPath(`${home}/.credentials.json`, distro), constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Desktop account list for WSL accounts. `on` means the guest credential file is readable, so the
 * guest listener can bill through it. No readable file is `unsupported:wsl` (no Windows credential-store reader).
 */
export function wslAuthProxyStatus(
  accounts: readonly WslAuthProxyAccount[],
  readable: (account: WslAuthProxyAccount) => boolean = wslCredentialFileReadable
): 'on' | 'unsupported:wsl' | undefined {
  const wslAccounts = accounts.filter((account) => account.managedAuthRuntime === 'wsl')
  if (wslAccounts.length === 0) {
    return undefined
  }
  return wslAccounts.some((account) => readable(account)) ? 'on' : 'unsupported:wsl'
}
