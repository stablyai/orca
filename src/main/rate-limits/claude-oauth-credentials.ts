import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { readActiveClaudeKeychainCredentialsStrict } from '../claude-accounts/keychain'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth/runtime-auth-types'
import { readUserClaudeConfigDir } from '../claude-accounts/claude-profile-paths'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'

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
  unavailable?: boolean
}
type ClaudeOAuthCredentialReadOptions = {
  signal?: AbortSignal
  credentialsFileConfigDir?: string
  keychainConfigDir?: string
  /** System Default only: a managed profile never reads another login's item. */
  unsuffixedKeychainFallback?: boolean
}
const schema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string().optional(),
      refreshToken: z.string().optional()
    })
    .optional()
})
export function parseClaudeOAuthCredentialsJson(
  raw: string,
  source: ClaudeOAuthCredentialSource
): ClaudeOAuthCredentialReadResult {
  try {
    const oauth = schema.parse(JSON.parse(raw)).claudeAiOauth
    // Why: expiresAt is not authoritative for the usage endpoint; let the server decide.
    return {
      token: oauth?.accessToken || null,
      hasRefreshableCredentials: Boolean(oauth?.refreshToken),
      source
    }
  } catch {
    return { ...emptyClaudeOAuthCredentialReadResult(), unavailable: true }
  }
}
export function emptyClaudeOAuthCredentialReadResult(): ClaudeOAuthCredentialReadResult {
  return { token: null, hasRefreshableCredentials: false, source: 'none' }
}
export async function readClaudeCredentialsFromStrictKeychain(
  configDir: string | undefined,
  source: ClaudeOAuthCredentialSource,
  signal?: AbortSignal
): Promise<ClaudeOAuthCredentialReadResult> {
  signal?.throwIfAborted()
  try {
    const contents = await readActiveClaudeKeychainCredentialsStrict(
      configDir,
      ...(signal ? [signal] : [])
    )
    signal?.throwIfAborted()
    return contents
      ? parseClaudeOAuthCredentialsJson(contents, source)
      : emptyClaudeOAuthCredentialReadResult()
  } catch {
    signal?.throwIfAborted()
    return {
      ...emptyClaudeOAuthCredentialReadResult(),
      unavailable: true,
      keychainUnavailable: true
    }
  }
}
async function readClaudeKeychainCredentials(
  options?: ClaudeOAuthCredentialReadOptions
): Promise<ClaudeOAuthCredentialReadResult> {
  if (!options?.keychainConfigDir) {
    return readClaudeCredentialsFromStrictKeychain(undefined, 'legacy-keychain', options?.signal)
  }
  const scoped = await readClaudeCredentialsFromStrictKeychain(
    options.keychainConfigDir,
    'scoped-keychain',
    options.signal
  )
  options.signal?.throwIfAborted()
  if (scoped.token || !options.unsuffixedKeychainFallback) {
    return scoped
  }
  const legacy = await readClaudeCredentialsFromStrictKeychain(
    undefined,
    'legacy-keychain',
    options.signal
  )
  options.signal?.throwIfAborted()
  // Why: as before profiles, a token wins over an unreadable item.
  const candidates = [scoped, legacy]
  return (
    candidates.find((candidate) => candidate.token) ??
    candidates.find((candidate) => candidate.unavailable) ??
    legacy
  )
}
export async function readClaudeOAuthCredentials(
  options?: ClaudeOAuthCredentialReadOptions
): Promise<ClaudeOAuthCredentialReadResult> {
  options?.signal?.throwIfAborted()
  const keychain =
    process.platform === 'darwin'
      ? await readClaudeKeychainCredentials(options)
      : emptyClaudeOAuthCredentialReadResult()
  options?.signal?.throwIfAborted()
  if (keychain.token) {
    return keychain
  }
  try {
    const contents = await readFile(
      path.join(
        options?.credentialsFileConfigDir ?? path.join(homedir(), '.claude'),
        '.credentials.json'
      ),
      'utf8'
    )
    options?.signal?.throwIfAborted()
    return parseClaudeOAuthCredentialsJson(contents, 'credentials-file')
  } catch (error) {
    options?.signal?.throwIfAborted()
    return isDefinitiveAbsence(error) ? keychain : { ...keychain, unavailable: true }
  }
}
export function resolveClaudeOAuthCredentialReadOptions(
  authPreparation?: ClaudeRuntimeAuthPreparation
): ClaudeOAuthCredentialReadOptions | undefined {
  if (!authPreparation) {
    return undefined
  }
  const accountDir = authPreparation.envPatch.CLAUDE_CONFIG_DIR
  return {
    credentialsFileConfigDir: authPreparation.configDir,
    // Why the user's own folder, login shell first: Claude names System default's item from it.
    keychainConfigDir:
      accountDir ??
      getClaudeProfileRouter()?.userConfigDir() ??
      readUserClaudeConfigDir(process.env),
    // An unsuffixed lookup is exclusively System default, never a fallback from an account.
    unsuffixedKeychainFallback: !accountDir
  }
}
