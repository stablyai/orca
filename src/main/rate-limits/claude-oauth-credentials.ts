import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict
} from '../claude-accounts/keychain'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

type ClaudeCredentials = {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
  }
}

export type ClaudeOAuthCredentialSource =
  | 'scoped-keychain'
  | 'legacy-keychain'
  | 'credentials-file'
  | 'none'

export type ClaudeOAuthCredentialReadResult = {
  token: string | null
  hasRefreshableCredentials: boolean
  source: ClaudeOAuthCredentialSource
  keychainUnavailable?: boolean
  /** Carried through for callers that must not refresh; the usage endpoint ignores it. */
  expiresAt?: number
}

type ClaudeOAuthCredentialReadOptions = {
  credentialsFileConfigDir?: string
  keychainConfigDir?: string
}

export function parseClaudeOAuthCredentialsJson(
  raw: string,
  source: ClaudeOAuthCredentialSource
): ClaudeOAuthCredentialReadResult {
  try {
    const oauth = (JSON.parse(raw) as ClaudeCredentials)?.claudeAiOauth
    const hasRefreshableCredentials =
      typeof oauth?.refreshToken === 'string' && oauth.refreshToken.trim() !== ''
    const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined
    if (!oauth?.accessToken || typeof oauth.accessToken !== 'string') {
      return { token: null, hasRefreshableCredentials, source, expiresAt }
    }
    // Why: expiresAt is not authoritative for the usage endpoint; let the server decide.
    return { token: oauth.accessToken, hasRefreshableCredentials, source, expiresAt }
  } catch {
    return emptyClaudeOAuthCredentialReadResult()
  }
}

export function emptyClaudeOAuthCredentialReadResult(): ClaudeOAuthCredentialReadResult {
  return { token: null, hasRefreshableCredentials: false, source: 'none' }
}

function unavailableKeychainResult(): ClaudeOAuthCredentialReadResult {
  return {
    token: null,
    hasRefreshableCredentials: false,
    source: 'none',
    keychainUnavailable: true
  }
}

async function readFromKeychain(configDir?: string): Promise<ClaudeOAuthCredentialReadResult> {
  if (process.platform !== 'darwin') {
    return emptyClaudeOAuthCredentialReadResult()
  }

  if (configDir) {
    const scoped = await readClaudeCredentialsFromStrictKeychain(configDir, 'scoped-keychain')
    if (scoped.token) {
      return scoped
    }

    const legacy = await readClaudeCredentialsFromStrictKeychain(undefined, 'legacy-keychain')
    // Why: a real access token must not be shadowed by scoped refresh-only credentials.
    if (legacy.token) {
      return legacy
    }
    if (scoped.hasRefreshableCredentials) {
      return scoped
    }
    if (legacy.hasRefreshableCredentials) {
      return legacy
    }
    return scoped.keychainUnavailable || legacy.keychainUnavailable
      ? unavailableKeychainResult()
      : legacy
  }

  try {
    const credentials = await readActiveClaudeKeychainCredentials(configDir)
    return credentials
      ? parseClaudeOAuthCredentialsJson(credentials, 'legacy-keychain')
      : emptyClaudeOAuthCredentialReadResult()
  } catch {
    return unavailableKeychainResult()
  }
}

export async function readClaudeCredentialsFromStrictKeychain(
  configDir: string | undefined,
  source: ClaudeOAuthCredentialSource
): Promise<ClaudeOAuthCredentialReadResult> {
  try {
    const credentials = await readActiveClaudeKeychainCredentialsStrict(configDir)
    return credentials
      ? parseClaudeOAuthCredentialsJson(credentials, source)
      : emptyClaudeOAuthCredentialReadResult()
  } catch {
    return unavailableKeychainResult()
  }
}

export async function readClaudeOAuthCredentialsFile(
  configDir?: string
): Promise<ClaudeOAuthCredentialReadResult> {
  const credentialPath = path.join(
    configDir ?? path.join(homedir(), '.claude'),
    '.credentials.json'
  )
  try {
    return parseClaudeOAuthCredentialsJson(
      await readFile(credentialPath, 'utf-8'),
      'credentials-file'
    )
  } catch {
    return emptyClaudeOAuthCredentialReadResult()
  }
}

/**
 * Credentials that belong to exactly this config dir: its scoped Keychain item on darwin, then its
 * own `.credentials.json` — parsed, never merely present.
 *
 * Deliberately no legacy-Keychain fallback, unlike `readClaudeOAuthCredentials`: that item answers
 * for the shared login, so a signed-out bound directory would read as signed in and the launch
 * would land on another organisation's account.
 *
 * A Keychain that could not be read is reported as such rather than as "no credentials": the two
 * have different remedies, and a locked keychain is not a directory nobody signed into.
 */
export async function readClaudeConfigDirScopedOAuthCredentials(
  configDir: string,
  options?: {
    platform?: NodeJS.Platform
    readScopedKeychain?: (configDir: string) => Promise<string | null>
  }
): Promise<ClaudeOAuthCredentialReadResult> {
  let keychainUnavailable = false
  if ((options?.platform ?? process.platform) === 'darwin') {
    const scoped = options?.readScopedKeychain
      ? await readInjectedScopedKeychain(configDir, options.readScopedKeychain)
      : await readClaudeCredentialsFromStrictKeychain(configDir, 'scoped-keychain')
    if (scoped.token || scoped.hasRefreshableCredentials) {
      return scoped
    }
    keychainUnavailable = scoped.keychainUnavailable === true
  }
  const file = await readClaudeOAuthCredentialsFile(configDir)
  return !file.token && !file.hasRefreshableCredentials && keychainUnavailable
    ? unavailableKeychainResult()
    : file
}

async function readInjectedScopedKeychain(
  configDir: string,
  read: (configDir: string) => Promise<string | null>
): Promise<ClaudeOAuthCredentialReadResult> {
  try {
    const credentials = await read(configDir)
    return credentials
      ? parseClaudeOAuthCredentialsJson(credentials, 'scoped-keychain')
      : emptyClaudeOAuthCredentialReadResult()
  } catch {
    return unavailableKeychainResult()
  }
}

export async function readClaudeOAuthCredentials(
  options?: ClaudeOAuthCredentialReadOptions
): Promise<ClaudeOAuthCredentialReadResult> {
  const keychain = await readFromKeychain(options?.keychainConfigDir)
  if (keychain.token || keychain.hasRefreshableCredentials) {
    return keychain
  }

  const file = await readClaudeOAuthCredentialsFile(options?.credentialsFileConfigDir)
  if (file.token || file.hasRefreshableCredentials) {
    return file
  }
  return keychain.keychainUnavailable ? keychain : emptyClaudeOAuthCredentialReadResult()
}

export function resolveClaudeOAuthCredentialReadOptions(
  authPreparation?: ClaudeRuntimeAuthPreparation
): ClaudeOAuthCredentialReadOptions | undefined {
  if (!authPreparation) {
    return undefined
  }
  return {
    credentialsFileConfigDir: authPreparation.configDir,
    keychainConfigDir: authPreparation.configDir
  }
}
