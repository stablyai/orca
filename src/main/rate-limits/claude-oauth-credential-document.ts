import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  claudeConfigDirKeychainAliases,
  claudeKeychainAccount,
  claudeKeychainService
} from '../claude-accounts/keychain'
import { isKeychainNotFoundError, readKeychainPassword } from '../macos-keychain/generic-password'
import type { ClaudeOAuthCredentialReadOptions } from './claude-oauth-credentials'

export type ClaudeOAuthCredentialStore =
  | { kind: 'keychain'; service: string; account: string }
  | { kind: 'file'; path: string }

export type ClaudeOAuthCredentialDocument = {
  parsed: Record<string, unknown>
  oauth: Record<string, unknown>
  refreshToken: string
  store: ClaudeOAuthCredentialStore
}

export type ClaudeOAuthCredentialReadResult =
  | { ok: true; document: ClaudeOAuthCredentialDocument }
  | { ok: false; reason: 'keychain-unavailable' | 'no-refresh-token' | 'unreadable' }

export async function readClaudeOAuthCredentialDocument(
  options: ClaudeOAuthCredentialReadOptions | undefined
): Promise<ClaudeOAuthCredentialReadResult> {
  if (process.platform === 'darwin') {
    let keychain: ClaudeOAuthCredentialDocument | 'denied' | null = null
    try {
      keychain = await readKeychainDocument(options)
    } catch {
      // A test double that omits the keychain helpers is a miss, not a locked item.
      keychain = null
    }
    if (keychain === 'denied') {
      return { ok: false, reason: 'keychain-unavailable' }
    }
    if (keychain) {
      return { ok: true, document: keychain }
    }
  }
  const credentialsPath = credentialsFilePath(options?.credentialsFileConfigDir)
  try {
    const fileJson = await readFile(credentialsPath, 'utf8')
    const loaded = parseCredentialDocument(fileJson, { kind: 'file', path: credentialsPath })
    return loaded ? { ok: true, document: loaded } : { ok: false, reason: 'no-refresh-token' }
  } catch (error) {
    return isDefinitiveAbsence(error)
      ? { ok: false, reason: 'no-refresh-token' }
      : { ok: false, reason: 'unreadable' }
  }
}

export function asClaudeOAuthRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  // SAFETY: the check above excludes null and arrays, so this is a plain object.
  return value as Record<string, unknown>
}

export function claudeOAuthStringField(
  body: Record<string, unknown> | null,
  key: string
): string | null {
  const value = body?.[key]
  return typeof value === 'string' && value ? value : null
}

async function readKeychainDocument(
  options: ClaudeOAuthCredentialReadOptions | undefined
): Promise<ClaudeOAuthCredentialDocument | 'denied' | null> {
  const account = claudeKeychainAccount()
  const services = options?.keychainConfigDir
    ? claudeConfigDirKeychainAliases(options.keychainConfigDir).map((dir) =>
        claudeKeychainService(dir)
      )
    : [claudeKeychainService()]
  if (options?.keychainConfigDir && options.unsuffixedKeychainFallback) {
    services.push(claudeKeychainService())
  }
  let denied = false
  for (const service of services) {
    try {
      const raw = await readKeychainPassword(service, account)
      const document = raw
        ? parseCredentialDocument(raw, { kind: 'keychain', service, account })
        : null
      if (document) {
        return document
      }
    } catch (error) {
      if (!isKeychainNotFoundError(error)) {
        denied = true
      }
    }
  }
  return denied ? 'denied' : null
}

function credentialsFilePath(configDir: string | undefined): string {
  return path.join(configDir ?? path.join(homedir(), '.claude'), '.credentials.json')
}

function parseCredentialDocument(
  raw: string,
  store: ClaudeOAuthCredentialStore
): ClaudeOAuthCredentialDocument | null {
  try {
    const parsed = asClaudeOAuthRecord(JSON.parse(raw))
    const oauth = asClaudeOAuthRecord(parsed?.claudeAiOauth)
    const refreshToken = typeof oauth?.refreshToken === 'string' ? oauth.refreshToken : ''
    if (!parsed || !oauth || !refreshToken) {
      return null
    }
    return { parsed, oauth, refreshToken, store }
  } catch {
    return null
  }
}
