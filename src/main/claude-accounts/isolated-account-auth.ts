// Enrolled accounts share the CLI's canonical credential instead of rotating a private copy.
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { stripSharedClaudeCredentialFields } from './shared-credential-fields'
import {
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from './keychain'
import {
  readClaudeManagedAuthFile,
  resolveOwnedClaudeManagedAuthPath,
  writeClaudeManagedAuthFile
} from './managed-auth-path'

export type ClaudeAccountCredentialLocation = { accountId: string; managedAuthPath: string }
const ISOLATED_MARKER = '.orca-claude-isolated-auth'

export function writeIsolatedClaudeAccountMetadata(
  managedAuthPath: string,
  oauthAccount: unknown
): void {
  const existing = readClaudeManagedAuthFile(managedAuthPath, '.claude.json')
  const parsed: unknown = existing ? JSON.parse(existing) : {}
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The managed Claude configuration is invalid.')
  }
  writeClaudeManagedAuthFile(
    managedAuthPath,
    '.claude.json',
    JSON.stringify({ ...parsed, oauthAccount })
  )
}

export function hasIsolatedClaudeAccountAuth(managedAuthPath: string): boolean {
  if (!lstatSync(join(managedAuthPath, ISOLATED_MARKER), { throwIfNoEntry: false })) {
    return false
  }
  if (readClaudeManagedAuthFile(managedAuthPath, ISOLATED_MARKER) !== '1\n') {
    throw new Error('The isolated Claude credential marker is invalid. Reconnect this account.')
  }
  return true
}

function ownedLocation(location: ClaudeAccountCredentialLocation): ClaudeAccountCredentialLocation {
  const managedAuthPath = resolveOwnedClaudeManagedAuthPath(
    location.accountId,
    location.managedAuthPath
  )
  if (!managedAuthPath) {
    throw new Error('Managed Claude auth storage is not owned by Orca.')
  }
  return { accountId: location.accountId, managedAuthPath }
}

export async function readClaudeAccountCredentials(
  location: ClaudeAccountCredentialLocation,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  const owned = ownedLocation(location)
  if (platform !== 'darwin') {
    return readClaudeManagedAuthFile(owned.managedAuthPath, '.credentials.json')
  }
  return hasIsolatedClaudeAccountAuth(owned.managedAuthPath)
    ? readActiveClaudeKeychainCredentialsStrict(owned.managedAuthPath)
    : readManagedClaudeKeychainCredentials(owned.accountId)
}

export async function writeClaudeAccountCredentials(
  location: ClaudeAccountCredentialLocation,
  credentialsJson: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const owned = ownedLocation(location)
  if (platform !== 'darwin') {
    writeClaudeManagedAuthFile(owned.managedAuthPath, '.credentials.json', credentialsJson)
  } else if (hasIsolatedClaudeAccountAuth(owned.managedAuthPath)) {
    await writeActiveClaudeKeychainCredentials(credentialsJson, owned.managedAuthPath)
  } else {
    await writeManagedClaudeKeychainCredentials(owned.accountId, credentialsJson)
  }
}

/** Caller holds account mutation authority and has excluded legacy live credential owners. */
export async function enrollIsolatedClaudeAccount(
  location: ClaudeAccountCredentialLocation,
  metadata: { oauthAccount: unknown },
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const owned = ownedLocation(location)
  const credentials = await readClaudeAccountCredentials(owned, platform)
  if (!credentials) {
    throw new Error('This Claude account has no credential. Reconnect it before launching.')
  }
  if (hasIsolatedClaudeAccountAuth(owned.managedAuthPath)) {
    return
  }
  writeIsolatedClaudeAccountMetadata(owned.managedAuthPath, metadata.oauthAccount)
  // A legacy snapshot's connector grants belong to the shared runtime, not the new live home.
  const isolatedCredentials = stripSharedClaudeCredentialFields(credentials)
  if (platform === 'darwin') {
    await writeActiveClaudeKeychainCredentials(isolatedCredentials, owned.managedAuthPath)
  } else if (isolatedCredentials !== credentials) {
    writeClaudeManagedAuthFile(owned.managedAuthPath, '.credentials.json', isolatedCredentials)
  }
  // Commit authority last; a failed scoped write must leave the private credential authoritative.
  writeClaudeManagedAuthFile(owned.managedAuthPath, ISOLATED_MARKER, '1\n')
}
