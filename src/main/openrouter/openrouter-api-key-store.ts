import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'

/**
 * On-disk store for the OpenRouter API key.
 *
 * Mirrors the MiniMax key store: the key lives outside GlobalSettings so it is
 * never carried in a settings snapshot to the renderer or mobile, and it is
 * sealed with safeStorage when the platform offers it. The envelope records
 * which of the two it was, so a machine that loses its keyring reports a
 * decrypt failure instead of handing back ciphertext as if it were a key.
 */

const OPENROUTER_API_KEY_FILE = 'openrouter-api-key.enc'
const API_KEY_ENVELOPE_PREFIX = 'orca-openrouter-api-key:v1:'
let cachedOpenRouterApiKey: string | null = null
let warnedOpenRouterApiKeyStatusHardenFailure = false

type OpenRouterApiKeyEnvelope = {
  kind: 'encrypted' | 'plaintext'
  payload: Buffer
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getOpenRouterApiKeyPath(): string {
  return join(getOrcaDir(), OPENROUTER_API_KEY_FILE)
}

function encodeApiKeyEnvelope(kind: OpenRouterApiKeyEnvelope['kind'], payload: Buffer): string {
  return `${API_KEY_ENVELOPE_PREFIX}${kind}:${payload.toString('base64')}`
}

function decodeApiKeyEnvelope(raw: Buffer): OpenRouterApiKeyEnvelope {
  const text = raw.toString('utf8')
  if (!text.startsWith(API_KEY_ENVELOPE_PREFIX)) {
    throw new Error('OpenRouter API key could not be decrypted')
  }
  const rest = text.slice(API_KEY_ENVELOPE_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator === -1) {
    throw new Error('OpenRouter API key could not be decrypted')
  }
  const kind = rest.slice(0, separator)
  if (kind !== 'encrypted' && kind !== 'plaintext') {
    throw new Error('OpenRouter API key could not be decrypted')
  }
  return {
    kind,
    payload: Buffer.from(rest.slice(separator + 1), 'base64')
  }
}

function readEnvelope(envelope: OpenRouterApiKeyEnvelope): string {
  if (envelope.kind === 'plaintext') {
    return envelope.payload.toString('utf8')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OpenRouter API key could not be decrypted')
  }
  return safeStorage.decryptString(envelope.payload)
}

export function hasOpenRouterApiKey(): boolean {
  const keyPath = getOpenRouterApiKeyPath()
  if (!existsSync(keyPath)) {
    return false
  }
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    if (!warnedOpenRouterApiKeyStatusHardenFailure) {
      warnedOpenRouterApiKeyStatusHardenFailure = true
      console.warn(
        '[openrouter] Failed to harden OpenRouter API key file while checking status',
        error
      )
    }
  }
  return true
}

export function saveOpenRouterApiKey(key: string): void {
  const trimmed = key.trim()
  if (!trimmed) {
    throw new Error('OpenRouter API key is required')
  }
  if (safeStorage.isEncryptionAvailable()) {
    writeSecureFile(
      getOpenRouterApiKeyPath(),
      encodeApiKeyEnvelope('encrypted', safeStorage.encryptString(trimmed))
    )
    cachedOpenRouterApiKey = trimmed
    return
  }
  console.warn(
    '[openrouter] safeStorage encryption unavailable — storing OpenRouter API key in plaintext'
  )
  writeSecureFile(
    getOpenRouterApiKeyPath(),
    encodeApiKeyEnvelope('plaintext', Buffer.from(trimmed, 'utf8'))
  )
  cachedOpenRouterApiKey = trimmed
}

export function readOpenRouterApiKey(): string | null {
  if (cachedOpenRouterApiKey !== null) {
    return cachedOpenRouterApiKey
  }
  const keyPath = getOpenRouterApiKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  // Why: keep hardening out of the decode/decrypt try below so a chmod/ACL
  // failure isn't misreported as a decrypt failure (matches hasOpenRouterApiKey).
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    console.warn('[openrouter] Failed to harden OpenRouter API key file while reading', error)
  }
  try {
    const raw = readFileSync(keyPath)
    const envelope = decodeApiKeyEnvelope(raw)
    cachedOpenRouterApiKey = readEnvelope(envelope)
    return cachedOpenRouterApiKey
  } catch (error) {
    console.error('[openrouter] failed to decode/decrypt API key', error)
    throw new Error('OpenRouter API key could not be decrypted')
  }
}

export function clearOpenRouterApiKey(): void {
  cachedOpenRouterApiKey = null
  rmSync(getOpenRouterApiKeyPath(), { force: true })
}
