import { safeStorage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'
import type { CustomProviderAccount } from '../../shared/custom-provider-types'

// Why: one encrypted file holding a map of {accountId: token}, mirroring
// minimax-cookie-store.ts's envelope scheme but keyed for an arbitrary-length
// list of custom provider accounts instead of a single slot.
const TOKENS_FILE = 'custom-provider-tokens.enc'
const TOKENS_ENVELOPE_PREFIX = 'orca-custom-provider-tokens:v1:'
let cachedTokens: Map<string, string> | null = null

function getTokensPath(): string {
  return join(homedir(), '.orca', TOKENS_FILE)
}

function encodeEnvelope(kind: 'encrypted' | 'plaintext', payload: Buffer): string {
  return `${TOKENS_ENVELOPE_PREFIX}${kind}:${payload.toString('base64')}`
}

function decodeEnvelope(raw: Buffer): { kind: 'encrypted' | 'plaintext'; payload: Buffer } {
  const text = raw.toString('utf8')
  if (!text.startsWith(TOKENS_ENVELOPE_PREFIX)) {
    throw new Error('Custom provider token store could not be decrypted')
  }
  const rest = text.slice(TOKENS_ENVELOPE_PREFIX.length)
  const separator = rest.indexOf(':')
  const kind = separator === -1 ? '' : rest.slice(0, separator)
  if (kind !== 'encrypted' && kind !== 'plaintext') {
    throw new Error('Custom provider token store could not be decrypted')
  }
  return { kind, payload: Buffer.from(rest.slice(separator + 1), 'base64') }
}

function decodePayload(envelope: { kind: 'encrypted' | 'plaintext'; payload: Buffer }): string {
  if (envelope.kind === 'plaintext') {
    return envelope.payload.toString('utf8')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Custom provider token store could not be decrypted')
  }
  return safeStorage.decryptString(envelope.payload)
}

function loadTokens(): Map<string, string> {
  if (cachedTokens) {
    return cachedTokens
  }
  const path = getTokensPath()
  if (!existsSync(path)) {
    cachedTokens = new Map()
    return cachedTokens
  }
  try {
    hardenExistingSecureFile(path)
  } catch (error) {
    console.warn('[custom-providers] Failed to harden token store while reading', error)
  }
  try {
    const raw = readFileSync(path)
    const json = decodePayload(decodeEnvelope(raw))
    const parsed: unknown = JSON.parse(json)
    cachedTokens = new Map(
      typeof parsed === 'object' && parsed !== null ? Object.entries(parsed as object) : []
    )
    return cachedTokens
  } catch (error) {
    console.error('[custom-providers] failed to decode/decrypt token store', error)
    throw new Error('Custom provider token store could not be decrypted')
  }
}

function persistTokens(tokens: Map<string, string>): void {
  const json = JSON.stringify(Object.fromEntries(tokens))
  if (safeStorage.isEncryptionAvailable()) {
    writeSecureFile(getTokensPath(), encodeEnvelope('encrypted', safeStorage.encryptString(json)))
    return
  }
  console.warn(
    '[custom-providers] safeStorage encryption unavailable — storing tokens in plaintext'
  )
  writeSecureFile(getTokensPath(), encodeEnvelope('plaintext', Buffer.from(json, 'utf8')))
}

export function hasCustomProviderToken(accountId: string): boolean {
  return loadTokens().has(accountId)
}

export function readCustomProviderToken(accountId: string): string | null {
  return loadTokens().get(accountId) ?? null
}

export function saveCustomProviderToken(accountId: string, token: string): void {
  const trimmed = token.trim()
  if (!trimmed) {
    throw new Error('Custom provider token is required')
  }
  const tokens = new Map(loadTokens())
  tokens.set(accountId, trimmed)
  persistTokens(tokens)
  cachedTokens = tokens
}

export function clearCustomProviderToken(accountId: string): void {
  const tokens = new Map(loadTokens())
  if (!tokens.delete(accountId)) {
    return
  }
  persistTokens(tokens)
  cachedTokens = tokens
}

/** Resolves the token to actually use for a fetch: `tokenEnvVar` (re-read from
 *  process.env every call, so rotating it never needs a restart) takes
 *  priority when it has a non-empty value; otherwise falls back to
 *  `fallbackToken` (e.g. the keychain-stored token, or a draft's typed value). */
export function resolveCustomProviderToken(
  account: Pick<CustomProviderAccount, 'tokenEnvVar'>,
  fallbackToken: string | null
): string | null {
  if (account.tokenEnvVar) {
    const envValue = process.env[account.tokenEnvVar]
    if (envValue) {
      return envValue
    }
  }
  return fallbackToken
}
