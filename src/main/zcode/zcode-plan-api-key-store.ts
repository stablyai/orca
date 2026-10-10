import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import { CredentialWriteOrder } from '../credentials/credential-write-order'

const ZCODE_PLAN_API_KEY_FILE = 'zcode-plan-api-key.enc'
const API_KEY_ENVELOPE_PREFIX = 'orca-zcode-plan-api-key:v1:'
let cachedZcodePlanApiKey: string | null = null
let warnedZcodePlanApiKeyStatusHardenFailure = false
const writeOrder = new CredentialWriteOrder('GLM Coding Plan API key')

type ZcodePlanApiKeyEnvelope = {
  kind: 'encrypted' | 'plaintext'
  payload: Buffer
}

function getZcodePlanApiKeyPath(): string {
  return join(homedir(), '.orca', ZCODE_PLAN_API_KEY_FILE)
}

function encodeApiKeyEnvelope(kind: ZcodePlanApiKeyEnvelope['kind'], payload: Buffer): string {
  return `${API_KEY_ENVELOPE_PREFIX}${kind}:${payload.toString('base64')}`
}

function decodeApiKeyEnvelope(raw: Buffer): ZcodePlanApiKeyEnvelope {
  const text = raw.toString('utf8')
  if (!text.startsWith(API_KEY_ENVELOPE_PREFIX)) {
    throw new Error('GLM Coding Plan API key could not be decrypted')
  }
  const rest = text.slice(API_KEY_ENVELOPE_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator === -1) {
    throw new Error('GLM Coding Plan API key could not be decrypted')
  }
  const kind = rest.slice(0, separator)
  if (kind !== 'encrypted' && kind !== 'plaintext') {
    throw new Error('GLM Coding Plan API key could not be decrypted')
  }
  return {
    kind,
    payload: Buffer.from(rest.slice(separator + 1), 'base64')
  }
}

function readEnvelope(envelope: ZcodePlanApiKeyEnvelope): string {
  if (envelope.kind === 'plaintext') {
    return envelope.payload.toString('utf8')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('GLM Coding Plan API key could not be decrypted')
  }
  return safeStorage.decryptString(envelope.payload)
}

export function hasZcodePlanApiKey(): boolean {
  const keyPath = getZcodePlanApiKeyPath()
  if (!existsSync(keyPath)) {
    return false
  }
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    if (!warnedZcodePlanApiKeyStatusHardenFailure) {
      warnedZcodePlanApiKeyStatusHardenFailure = true
      console.warn(
        '[zcode] Failed to harden GLM Coding Plan API key file while checking status',
        error
      )
    }
  }
  return true
}

export function getZcodePlanApiKeyProtection(): SecretAtRestProtection | null {
  const keyPath = getZcodePlanApiKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    return decodeApiKeyEnvelope(readFileSync(keyPath)).kind === 'plaintext' ? 'plaintext' : 'sealed'
  } catch {
    return null
  }
}

export async function saveZcodePlanApiKey(key: string): Promise<void> {
  const trimmed = key.trim()
  if (!trimmed) {
    throw new Error('GLM Coding Plan API key is required')
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new Error('GLM Coding Plan API key must be a single line')
  }
  const turn = writeOrder.begin()
  const sealed = (await safeStorage.isAsyncEncryptionAvailable())
    ? await safeStorage.encryptStringAsync(trimmed)
    : null
  turn.assertLatest()
  if (sealed) {
    writeSecureFile(getZcodePlanApiKeyPath(), encodeApiKeyEnvelope('encrypted', sealed))
    cachedZcodePlanApiKey = trimmed
    return
  }
  console.warn(
    '[zcode] safeStorage encryption unavailable — storing GLM Coding Plan API key in plaintext'
  )
  const keyPath = getZcodePlanApiKeyPath()
  // Why: capture the previous envelope — writeSecureFile has already replaced
  // the file by the time it reports that restriction failed, and deleting the
  // result must not take the user's previous working key with it.
  let previousEnvelope: Buffer | null = null
  if (existsSync(keyPath)) {
    try {
      previousEnvelope = readFileSync(keyPath)
    } catch {
      previousEnvelope = null
    }
  }
  const wroteRestricted = writeSecureFile(
    keyPath,
    encodeApiKeyEnvelope('plaintext', Buffer.from(trimmed, 'utf8'))
  )
  // Why: an unrestricted plaintext credential must never be reported as saved.
  if (!wroteRestricted) {
    if (!previousEnvelope) {
      rmSync(keyPath, { force: true })
    } else {
      try {
        writeSecureFile(keyPath, previousEnvelope.toString('utf8'))
      } catch {
        // Why: restriction is failing device-wide; the restored bytes keep the
        // previous credential available instead of deleting it, and the thrown
        // save error still tells the user the store is not secure.
      }
    }
    throw new Error('GLM Coding Plan API key could not be stored securely on this device')
  }
  cachedZcodePlanApiKey = trimmed
}

export function readZcodePlanApiKey(): string | null {
  if (cachedZcodePlanApiKey !== null) {
    return cachedZcodePlanApiKey
  }
  const keyPath = getZcodePlanApiKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  // Why: keep hardening out of the decode/decrypt try below so a chmod/ACL
  // failure isn't misreported as a decrypt failure (matches hasZcodePlanApiKey).
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    console.warn('[zcode] Failed to harden GLM Coding Plan API key file while reading', error)
  }
  try {
    const raw = readFileSync(keyPath)
    const envelope = decodeApiKeyEnvelope(raw)
    cachedZcodePlanApiKey = readEnvelope(envelope)
    return cachedZcodePlanApiKey
  } catch (error) {
    console.error('[zcode] failed to decode/decrypt GLM Coding Plan API key', error)
    throw new Error('GLM Coding Plan API key could not be decrypted')
  }
}

export function clearZcodePlanApiKey(): void {
  writeOrder.begin()
  cachedZcodePlanApiKey = null
  rmSync(getZcodePlanApiKeyPath(), { force: true })
}
