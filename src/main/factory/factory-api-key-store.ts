import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'

const FACTORY_API_KEY_FILE = 'factory-api-key.enc'
const KEY_ENVELOPE_PREFIX = 'orca-factory-key:v1:'
let cachedFactoryApiKey: string | null = null

type FactoryApiKeyEnvelope = {
  kind: 'encrypted' | 'plaintext'
  payload: Buffer
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getFactoryApiKeyPath(): string {
  return join(getOrcaDir(), FACTORY_API_KEY_FILE)
}

function encodeKeyEnvelope(kind: FactoryApiKeyEnvelope['kind'], payload: Buffer): string {
  return `${KEY_ENVELOPE_PREFIX}${kind}:${payload.toString('base64')}`
}

function decodeKeyEnvelope(raw: Buffer): FactoryApiKeyEnvelope | null {
  const text = raw.toString('utf8')
  if (!text.startsWith(KEY_ENVELOPE_PREFIX)) {
    return null
  }
  const rest = text.slice(KEY_ENVELOPE_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator < 0) {
    throw new Error('Factory API key could not be decrypted')
  }
  const kind = rest.slice(0, separator)
  if (kind !== 'encrypted' && kind !== 'plaintext') {
    throw new Error('Factory API key could not be decrypted')
  }
  return {
    kind,
    payload: Buffer.from(rest.slice(separator + 1), 'base64')
  }
}

function readEnvelope(envelope: FactoryApiKeyEnvelope): string {
  if (envelope.kind === 'plaintext') {
    return envelope.payload.toString('utf8')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Factory API key could not be decrypted')
  }
  return safeStorage.decryptString(envelope.payload)
}

export function saveFactoryApiKey(key: string): void {
  const trimmed = key.trim()
  if (!trimmed) {
    throw new Error('Factory API key is required')
  }
  if (safeStorage.isEncryptionAvailable()) {
    writeSecureFile(
      getFactoryApiKeyPath(),
      encodeKeyEnvelope('encrypted', safeStorage.encryptString(trimmed))
    )
    cachedFactoryApiKey = trimmed
    return
  }
  console.warn(
    '[factory] safeStorage encryption unavailable — storing Factory API key in plaintext'
  )
  writeSecureFile(
    getFactoryApiKeyPath(),
    encodeKeyEnvelope('plaintext', Buffer.from(trimmed, 'utf8'))
  )
  cachedFactoryApiKey = trimmed
}

export function readFactoryApiKey(): string | null {
  if (cachedFactoryApiKey !== null) {
    return cachedFactoryApiKey
  }
  const keyPath = getFactoryApiKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  // Why: keep hardening out of the decode/decrypt try below so a chmod/ACL
  // failure isn't misreported as a decrypt failure.
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    console.warn('[factory] Failed to harden Factory API key file while reading', error)
  }
  try {
    const raw = readFileSync(keyPath)
    const envelope = decodeKeyEnvelope(raw)
    if (!envelope) {
      // No pre-envelope format exists for Factory; an unrecognized file is an error.
      throw new Error('Factory API key could not be decrypted')
    }
    cachedFactoryApiKey = readEnvelope(envelope)
    return cachedFactoryApiKey
  } catch (error) {
    console.error('[factory] failed to decode/decrypt API key', error)
    throw new Error('Factory API key could not be decrypted')
  }
}

export function clearFactoryApiKey(): void {
  cachedFactoryApiKey = null
  rmSync(getFactoryApiKeyPath(), { force: true })
}
