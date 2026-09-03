import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  readActiveClaudeKeychainCredentialsStrict,
  writeActiveClaudeKeychainCredentials
} from '../claude-accounts/keychain'
import {
  CLAUDE_CREDENTIALS_ABSENT,
  classifyClaudeCredentialsBlob,
  claudeCredentialsUnavailable,
  readComposedClaudeCredentials,
  type ClaudeCredentialReadResult
} from '../claude-accounts/claude-credential-read-result'
import { hasClaudeStaleFallbackMark } from '../claude-accounts/claude-stale-fallback-marker'
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
  const result = await readClaudeManagedCredentialsObserved(location)
  return result.kind === 'present' ? result.credentialsJson : null
}

export type ClaudeManagedCredentialsReadResult = ClaudeCredentialReadResult

/**
 * Reads the account's credential from the store the CLI itself owns: on macOS the config-dir
 * scoped Keychain item, with the same-home `.credentials.json` as the CLI's own durable fallback.
 *
 * Why not the account-id-keyed service any more: that was Orca's private second copy, and keeping
 * it in step with the CLI's rotations is the reconciliation this refactor removes.
 */
export async function readClaudeManagedCredentialsObserved(
  location: ClaudeManagedCredentialsLocation
): Promise<ClaudeManagedCredentialsReadResult> {
  if (location.kind !== 'keychain') {
    try {
      return classifyClaudeCredentialsBlob(
        readClaudeManagedAuthFile(location.managedAuthPath, '.credentials.json')
      )
    } catch (error) {
      return isDefinitiveAbsence(error)
        ? CLAUDE_CREDENTIALS_ABSENT
        : claudeCredentialsUnavailable('malformed')
    }
  }
  return readComposedClaudeCredentials({
    readScopedKeychain: () => readActiveClaudeKeychainCredentialsStrict(location.managedAuthPath),
    hasStaleFallbackMarker: () => hasClaudeStaleFallbackMark(location.managedAuthPath),
    readSameHomeFile: () => {
      try {
        return readClaudeManagedAuthFile(location.managedAuthPath, '.credentials.json')
      } catch {
        return null
      }
    }
  })
}

export async function writeClaudeManagedCredentialsJson(
  location: ClaudeManagedCredentialsLocation,
  credentialsJson: string
): Promise<void> {
  if (location.kind === 'keychain') {
    await writeActiveClaudeKeychainCredentials(credentialsJson, location.managedAuthPath)
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

/**
 * No-op passthrough, deliberately kept as a seam.
 *
 * Why it must not stage: it used to write the credential into the config-dir scoped Keychain item
 * and delete it in `finally`. That item is now the CLI's own live store, so the delete would sign
 * the user out every time the usage panel was opened. The credential is already where the CLI
 * keeps it; a usage read needs no staging at all.
 */
export async function withClaudeManagedPreviewKeychainCredentials<T>(
  _location: ClaudeManagedCredentialsLocation,
  _credentialsJson: string,
  operation: () => Promise<T>
): Promise<T> {
  return operation()
}
