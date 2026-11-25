import {
  inCredentialFileOrder,
  credentialFileExists,
  hardenCredentialFile,
  writeCredentialEnvelope as writeSecureFile
} from '../credentials/credential-file-io'
import { getSecretStore } from '../../shared/secure-storage/secret-store'
import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SecretAtRestProtection } from '../../shared/secure-storage/secret-at-rest-protection'

const ZCODE_PLAN_API_KEY_FILE = 'zcode-plan-api-key.enc'
export const API_KEY_ENVELOPE_PREFIX = 'orca-zcode-plan-api-key:v1:'
let cachedZcodePlanApiKey: string | null = null
let warnedZcodePlanApiKeyStatusHardenFailure = false

type ZcodePlanApiKeyEnvelope = {
  kind: 'encrypted' | 'plaintext'
  payload: Buffer
}

export function getZcodePlanApiKeyPath(): string {
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
  if (!getSecretStore().isEncryptionAvailable()) {
    throw new Error('GLM Coding Plan API key could not be decrypted')
  }
  return getSecretStore().decryptString(envelope.payload)
}

export async function hasZcodePlanApiKey(): Promise<boolean> {
  return inCredentialFileOrder(`${getZcodePlanApiKeyPath()}.mutation`, async () => {
    const keyPath = getZcodePlanApiKeyPath()
    if (!(await credentialFileExists(keyPath))) {
      return false
    }
    try {
      await hardenCredentialFile(keyPath)
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
  })
}

export async function getZcodePlanApiKeyProtection(): Promise<SecretAtRestProtection | null> {
  return inCredentialFileOrder(`${getZcodePlanApiKeyPath()}.mutation`, async () => {
    const keyPath = getZcodePlanApiKeyPath()
    if (!(await credentialFileExists(keyPath))) {
      return null
    }
    try {
      const envelope = decodeApiKeyEnvelope(await readFile(keyPath))
      return envelope.kind === 'plaintext' ? 'plaintext' : 'sealed'
    } catch {
      return null
    }
  })
}

async function rollbackPlaintextEnvelope(
  keyPath: string,
  attemptedEnvelope: string,
  previousEnvelope: Buffer | null
): Promise<void> {
  const attempted = Buffer.from(attemptedEnvelope, 'utf8')
  try {
    if (!(await readFile(keyPath)).equals(attempted)) {
      return
    }
    if (previousEnvelope) {
      try {
        await writeSecureFile(keyPath, previousEnvelope.toString('utf8'), {
          shouldPublish: async () => (await readFile(keyPath)).equals(attempted)
        })
      } catch {
        // A failed restore may already have published the previous envelope.
      }
    }
    const currentEnvelope = await readFile(keyPath)
    if (
      currentEnvelope.equals(attempted) &&
      (!previousEnvelope || !currentEnvelope.equals(previousEnvelope))
    ) {
      await rm(keyPath, { force: true })
    }
  } catch {
    // Unreadable current bytes do not establish ownership of the rejected write.
  }
}

export async function saveZcodePlanApiKey(key: string): Promise<void> {
  return inCredentialFileOrder(`${getZcodePlanApiKeyPath()}.mutation`, async () => {
    const trimmed = key.trim()
    if (!trimmed) {
      throw new Error('GLM Coding Plan API key is required')
    }
    if (/[\r\n]/.test(trimmed)) {
      throw new Error('GLM Coding Plan API key must be a single line')
    }
    if (getSecretStore().isEncryptionAvailable()) {
      await writeSecureFile(
        getZcodePlanApiKeyPath(),
        encodeApiKeyEnvelope('encrypted', getSecretStore().encryptString(trimmed))
      )
      cachedZcodePlanApiKey = trimmed
      return
    }
    console.warn(
      '[zcode] safeStorage encryption unavailable — storing GLM Coding Plan API key in plaintext'
    )
    const keyPath = getZcodePlanApiKeyPath()
    // Capture old bytes before secure publication can replace them yet report restriction failure; rollback must preserve the working key.
    let previousEnvelope: Buffer | null = null
    if (await credentialFileExists(keyPath)) {
      try {
        previousEnvelope = await readFile(keyPath)
      } catch {
        previousEnvelope = null
      }
    }
    const attemptedEnvelope = encodeApiKeyEnvelope('plaintext', Buffer.from(trimmed, 'utf8'))
    const wroteRestricted = await writeSecureFile(keyPath, attemptedEnvelope)
    // Unrestricted plaintext must never be acknowledged as saved.
    if (!wroteRestricted) {
      await rollbackPlaintextEnvelope(keyPath, attemptedEnvelope, previousEnvelope)
      throw new Error('GLM Coding Plan API key could not be stored securely on this device')
    }
    cachedZcodePlanApiKey = trimmed
  })
}

export async function readZcodePlanApiKey(): Promise<string | null> {
  return inCredentialFileOrder(`${getZcodePlanApiKeyPath()}.mutation`, async () => {
    if (cachedZcodePlanApiKey !== null) {
      return cachedZcodePlanApiKey
    }
    const keyPath = getZcodePlanApiKeyPath()
    if (!(await credentialFileExists(keyPath))) {
      return null
    }
    // Separate hardening from decryption so ACL/chmod faults cannot masquerade as decrypt failures.
    try {
      await hardenCredentialFile(keyPath)
    } catch (error) {
      console.warn('[zcode] Failed to harden GLM Coding Plan API key file while reading', error)
    }
    try {
      const raw = await readFile(keyPath)
      const envelope = decodeApiKeyEnvelope(raw)
      cachedZcodePlanApiKey = readEnvelope(envelope)
      return cachedZcodePlanApiKey
    } catch (error) {
      console.error('[zcode] failed to decode/decrypt GLM Coding Plan API key', error)
      throw new Error('GLM Coding Plan API key could not be decrypted')
    }
  })
}

export async function clearZcodePlanApiKey(): Promise<void> {
  return inCredentialFileOrder(`${getZcodePlanApiKeyPath()}.mutation`, async () => {
    cachedZcodePlanApiKey = null
    await rm(getZcodePlanApiKeyPath(), { force: true })
  })
}
