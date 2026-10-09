import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readActiveClaudeKeychainCredentialsStrict } from './keychain'

export type ClaudeIdentity = {
  email: string | null
  organizationUuid: string | null
  organizationName: string | null
}

export type CapturedClaudeAuth = {
  credentialsJson: string
  oauthAccount: unknown
  identity: ClaudeIdentity
}

export type ClaudeCaptureCommand = (
  args: string[],
  configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
  timeoutMs: number,
  options?: { allowFailure?: boolean }
) => Promise<string>

const STATUS_TIMEOUT_MS = 20_000

export async function captureClaudeAuthFromExistingConfigDir(
  configDir: string,
  previousLegacyCredentialsSha256: string | null | undefined,
  runCommand: ClaudeCaptureCommand
): Promise<CapturedClaudeAuth> {
  const trimmed = configDir.trim()
  if (!trimmed) {
    throw new Error('A Claude config directory path is required.')
  }
  const resolvedDir = resolve(trimmed)
  if (process.platform !== 'darwin' && !existsSync(join(resolvedDir, '.credentials.json'))) {
    throw new Error(
      `No Claude credentials found in ${resolvedDir}. Run \`claude login\` into this directory first.`
    )
  }

  let status = ''
  try {
    status = await runCommand(
      ['auth', 'status', '--json'],
      { windowsPath: resolvedDir, linuxPath: null, wslDistro: null },
      STATUS_TIMEOUT_MS,
      { allowFailure: true }
    )
  } catch (error) {
    console.warn('[claude-accounts] Could not read `claude auth status`:', error)
  }
  const currentLegacyKeychain = await readActiveClaudeKeychainCredentialsStrict()
  return captureClaudeAuthFromConfigDir(
    resolvedDir,
    status,
    currentLegacyKeychain,
    previousLegacyCredentialsSha256
  )
}

export async function captureClaudeAuthFromConfigDir(
  configDir: string,
  statusOutput: string,
  previousLegacyKeychain: string | null,
  previousLegacyCredentialsSha256?: string | null,
  readCredentials = readCapturedClaudeCredentials
): Promise<CapturedClaudeAuth> {
  const credentialsJson = await readCredentials(
    configDir,
    previousLegacyKeychain,
    previousLegacyCredentialsSha256
  )
  if (!credentialsJson) {
    throw new Error('Claude login completed, but no OAuth credentials were captured.')
  }
  const oauthAccount = readClaudeOauthAccount(configDir)
  return {
    credentialsJson,
    oauthAccount,
    identity: resolveClaudeIdentity(statusOutput, oauthAccount, credentialsJson)
  }
}

export async function readCapturedClaudeCredentials(
  configDir: string,
  previousLegacyKeychain: string | null,
  previousLegacyCredentialsSha256?: string | null
): Promise<string | null> {
  if (process.platform === 'darwin') {
    const scopedCredentialsJson = await readActiveClaudeKeychainCredentialsStrict(configDir)
    if (scopedCredentialsJson) {
      return scopedCredentialsJson
    }
    const legacyCredentialsJson = await readActiveClaudeKeychainCredentialsStrict()
    const legacyChanged =
      previousLegacyCredentialsSha256 === undefined
        ? legacyCredentialsJson !== previousLegacyKeychain
        : legacyCredentialsJson !== null &&
          createHash('sha256').update(legacyCredentialsJson).digest('hex') !==
            previousLegacyCredentialsSha256
    if (legacyCredentialsJson && legacyChanged) {
      return legacyCredentialsJson
    }
  }
  const credentialsPath = join(configDir, '.credentials.json')
  return existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf-8') : null
}

function readClaudeOauthAccount(configDir: string): unknown {
  for (const configPath of [join(configDir, '.claude.json'), join(configDir, '.config.json')]) {
    if (!existsSync(configPath)) {
      continue
    }
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
      if (parsed.oauthAccount) {
        return parsed.oauthAccount
      }
    } catch {
      continue
    }
  }
  return null
}

function resolveClaudeIdentity(
  statusOutput: string,
  oauthAccount: unknown,
  credentialsJson: string
): ClaudeIdentity {
  const status = parseJsonObject(statusOutput)
  const oauth = asRecord(oauthAccount)
  const credentialOauth = asRecord(parseJsonObject(credentialsJson)?.claudeAiOauth)
  return {
    email: normalizeField(
      readString(status, 'email') ??
        readString(oauth, 'emailAddress') ??
        readString(oauth, 'email') ??
        readString(credentialOauth, 'email')
    ),
    organizationUuid: normalizeField(
      readString(status, 'organizationUuid') ??
        readString(status, 'organizationId') ??
        readString(oauth, 'organizationUuid') ??
        readString(oauth, 'organizationId')
    ),
    organizationName: normalizeField(
      readString(status, 'organizationName') ?? readString(oauth, 'organizationName')
    )
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value) as unknown)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: Record<string, unknown> | null, key: string): string | null {
  return typeof value?.[key] === 'string' ? value[key] : null
}

function normalizeField(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}
