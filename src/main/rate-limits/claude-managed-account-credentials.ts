import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from '../claude-accounts/keychain'
import {
  readClaudeManagedAuthFile,
  resolveOwnedClaudeManagedAuthPath,
  writeClaudeManagedAuthFile
} from '../claude-accounts/managed-auth-path'

export type InactiveClaudeAccount = {
  id: string
  managedAuthPath: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxAuthPath?: string | null
}

export type ClaudeManagedCredentialsLocation =
  | { kind: 'keychain'; accountId: string; managedAuthPath: string }
  | { kind: 'file'; managedAuthPath: string }

export function resolveClaudeManagedCredentialsLocation(
  account: InactiveClaudeAccount
): ClaudeManagedCredentialsLocation | null {
  if (account.managedAuthRuntime === 'wsl') {
    const managedAuthPath = resolveOwnedWslClaudeManagedAuthPath(account)
    return managedAuthPath ? { kind: 'file', managedAuthPath } : null
  }
  const managedAuthPath = resolveOwnedClaudeManagedAuthPath(account.id, account.managedAuthPath, {
    adoptLegacyMarker: true
  })
  if (!managedAuthPath) {
    return null
  }
  return process.platform === 'darwin'
    ? { kind: 'keychain', accountId: account.id, managedAuthPath }
    : { kind: 'file', managedAuthPath }
}

export async function readClaudeManagedCredentialsJson(
  location: ClaudeManagedCredentialsLocation
): Promise<string | null> {
  try {
    return location.kind === 'keychain'
      ? await readManagedClaudeKeychainCredentials(location.accountId)
      : readClaudeManagedAuthFile(location.managedAuthPath, '.credentials.json')
  } catch {
    return null
  }
}

export async function writeClaudeManagedCredentialsJson(
  location: ClaudeManagedCredentialsLocation,
  credentialsJson: string
): Promise<void> {
  if (location.kind === 'keychain') {
    await writeManagedClaudeKeychainCredentials(location.accountId, credentialsJson)
  } else {
    writeClaudeManagedAuthFile(location.managedAuthPath, '.credentials.json', credentialsJson)
  }
}

function resolveOwnedWslClaudeManagedAuthPath(account: InactiveClaudeAccount): string | null {
  if (process.platform !== 'win32') {
    return null
  }
  const wslInfo = parseWslUncPath(account.managedAuthPath)
  if (!wslInfo || (account.wslDistro && wslInfo.distro !== account.wslDistro)) {
    return null
  }
  const linuxPath = account.wslLinuxAuthPath ?? wslInfo.linuxPath
  if (
    !linuxPath.includes('/.local/share/orca/claude-accounts/') ||
    !linuxPath.endsWith(`/${account.id}/auth`)
  ) {
    return null
  }
  try {
    const markerPath = path.join(account.managedAuthPath, '.orca-managed-claude-auth')
    if (
      !existsSync(markerPath) ||
      lstatSync(markerPath).isSymbolicLink() ||
      readFileSync(markerPath, 'utf-8').trim() !== account.id
    ) {
      return null
    }
    return account.managedAuthPath
  } catch {
    return null
  }
}

export async function withClaudeManagedPreviewKeychainCredentials<T>(
  location: ClaudeManagedCredentialsLocation,
  credentialsJson: string,
  operation: () => Promise<T>
): Promise<T> {
  if (location.kind !== 'keychain') {
    return operation()
  }
  await writeActiveClaudeKeychainCredentials(credentialsJson, location.managedAuthPath)
  try {
    return await operation()
  } finally {
    await deleteActiveClaudeKeychainCredentialsStrict(location.managedAuthPath).catch(() => {})
  }
}

export async function readStagedClaudeManagedPreviewCredentials(
  location: ClaudeManagedCredentialsLocation
): Promise<string | null> {
  if (location.kind !== 'keychain') {
    return null
  }
  try {
    return await readActiveClaudeKeychainCredentialsStrict(location.managedAuthPath)
  } catch {
    return null
  }
}
