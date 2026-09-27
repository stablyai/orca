import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'
import { ZHIPU_DEFAULT_BASE_URL, normalizeZhipuBaseUrl } from '../../shared/zhipu-usage'

const ZHIPU_CREDENTIALS_FILE = 'zhipu-credentials.enc'
const ZHIPU_CREDENTIALS_ENVELOPE_PREFIX = 'orca-zhipu-credentials:v1:'
let cachedZhipuCredentials: ZhipuCredentials | null = null
let warnedZhipuCredentialsStatusHardenFailure = false

export type ZhipuCredentials = {
  baseUrl: string
  authToken: string
}

type ZhipuCredentialsEnvelope = {
  kind: 'encrypted' | 'plaintext'
  payload: Buffer
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getZhipuCredentialsPath(): string {
  return join(getOrcaDir(), ZHIPU_CREDENTIALS_FILE)
}

function encodeCredentialsEnvelope(
  kind: ZhipuCredentialsEnvelope['kind'],
  payload: Buffer
): string {
  return `${ZHIPU_CREDENTIALS_ENVELOPE_PREFIX}${kind}:${payload.toString('base64')}`
}

function decodeCredentialsEnvelope(raw: Buffer): ZhipuCredentialsEnvelope | null {
  const text = raw.toString('utf8')
  if (!text.startsWith(ZHIPU_CREDENTIALS_ENVELOPE_PREFIX)) {
    return null
  }
  const rest = text.slice(ZHIPU_CREDENTIALS_ENVELOPE_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator === -1) {
    throw new Error('Zhipu credentials could not be decrypted')
  }
  const kind = rest.slice(0, separator)
  if (kind !== 'encrypted' && kind !== 'plaintext') {
    throw new Error('Zhipu credentials could not be decrypted')
  }
  return {
    kind,
    payload: Buffer.from(rest.slice(separator + 1), 'base64')
  }
}

function parseCredentials(value: string): ZhipuCredentials {
  const parsed = JSON.parse(value) as Partial<ZhipuCredentials>
  const authToken = typeof parsed.authToken === 'string' ? parsed.authToken.trim() : ''
  if (!authToken) {
    throw new Error('Zhipu auth token is required')
  }
  const baseUrl =
    typeof parsed.baseUrl === 'string'
      ? normalizeZhipuBaseUrl(parsed.baseUrl)
      : ZHIPU_DEFAULT_BASE_URL
  return { baseUrl, authToken }
}

function readEnvelope(envelope: ZhipuCredentialsEnvelope): string {
  if (envelope.kind === 'plaintext') {
    return envelope.payload.toString('utf8')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Zhipu credentials could not be decrypted')
  }
  return safeStorage.decryptString(envelope.payload)
}

function serializeCredentials(credentials: ZhipuCredentials): string {
  return JSON.stringify({
    baseUrl: normalizeZhipuBaseUrl(credentials.baseUrl),
    authToken: credentials.authToken.trim()
  })
}

export function hasZhipuCredentials(): boolean {
  const keyPath = getZhipuCredentialsPath()
  if (!existsSync(keyPath)) {
    return false
  }
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    if (!warnedZhipuCredentialsStatusHardenFailure) {
      warnedZhipuCredentialsStatusHardenFailure = true
      console.warn('[zhipu] Failed to harden Zhipu credentials file while checking status', error)
    }
  }
  return true
}

export function saveZhipuCredentials(credentials: ZhipuCredentials): void {
  const normalized = parseCredentials(serializeCredentials(credentials))
  const serialized = serializeCredentials(normalized)
  if (safeStorage.isEncryptionAvailable()) {
    writeSecureFile(
      getZhipuCredentialsPath(),
      encodeCredentialsEnvelope('encrypted', safeStorage.encryptString(serialized))
    )
    cachedZhipuCredentials = normalized
    return
  }
  console.warn(
    '[zhipu] safeStorage encryption unavailable - storing Zhipu credentials in plaintext'
  )
  writeSecureFile(
    getZhipuCredentialsPath(),
    encodeCredentialsEnvelope('plaintext', Buffer.from(serialized, 'utf8'))
  )
  cachedZhipuCredentials = normalized
}

export function readZhipuCredentials(): ZhipuCredentials | null {
  if (cachedZhipuCredentials !== null) {
    return cachedZhipuCredentials
  }
  const keyPath = getZhipuCredentialsPath()
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    console.warn('[zhipu] Failed to harden Zhipu credentials file while reading', error)
  }
  try {
    const raw = readFileSync(keyPath)
    const envelope = decodeCredentialsEnvelope(raw)
    if (!envelope) {
      throw new Error('Zhipu credentials could not be decrypted')
    }
    cachedZhipuCredentials = parseCredentials(readEnvelope(envelope))
    return cachedZhipuCredentials
  } catch (error) {
    console.error('[zhipu] failed to decode/decrypt credentials', error)
    throw new Error('Zhipu credentials could not be decrypted')
  }
}

export function clearZhipuCredentials(): void {
  cachedZhipuCredentials = null
  rmSync(getZhipuCredentialsPath(), { force: true })
}
