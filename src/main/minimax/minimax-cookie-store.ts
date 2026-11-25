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

const MINIMAX_COOKIE_FILE = 'minimax-session-cookie.enc'
export const COOKIE_ENVELOPE_PREFIX = 'orca-minimax-cookie:v1:'
let cachedMiniMaxCookie: string | null = null
let warnedMiniMaxCookieStatusHardenFailure = false

type MiniMaxCookieEnvelope = {
  kind: 'encrypted' | 'plaintext'
  payload: Buffer
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

export function getMiniMaxCookiePath(): string {
  return join(getOrcaDir(), MINIMAX_COOKIE_FILE)
}

function encodeCookieEnvelope(kind: MiniMaxCookieEnvelope['kind'], payload: Buffer): string {
  return `${COOKIE_ENVELOPE_PREFIX}${kind}:${payload.toString('base64')}`
}

function decodeCookieEnvelope(raw: Buffer): MiniMaxCookieEnvelope | null {
  const text = raw.toString('utf8')
  if (!text.startsWith(COOKIE_ENVELOPE_PREFIX)) {
    return null
  }
  const rest = text.slice(COOKIE_ENVELOPE_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator === -1) {
    throw new Error('MiniMax session cookie could not be decrypted')
  }
  const kind = rest.slice(0, separator)
  if (kind !== 'encrypted' && kind !== 'plaintext') {
    throw new Error('MiniMax session cookie could not be decrypted')
  }
  return {
    kind,
    payload: Buffer.from(rest.slice(separator + 1), 'base64')
  }
}

// Legacy files contain raw encrypted or plaintext bytes; sniff them before envelope migration.
function looksLikeCookieHeader(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index)
    if (code < 32 || code === 127) {
      return false
    }
  }
  return (
    /^Cookie:\s*\S+/i.test(trimmed) ||
    /(?:^|;\s*)[A-Za-z0-9_.-]+\s*=/.test(trimmed) ||
    /(?:^|[;\s])[A-Za-z0-9_.-]+\s*:\s*["'][^"']+["']/.test(trimmed)
  )
}

function readEnvelope(envelope: MiniMaxCookieEnvelope): string {
  if (envelope.kind === 'plaintext') {
    return envelope.payload.toString('utf8')
  }
  if (!getSecretStore().isEncryptionAvailable()) {
    throw new Error('MiniMax session cookie could not be decrypted')
  }
  return getSecretStore().decryptString(envelope.payload)
}

function readLegacyCookie(raw: Buffer): string {
  if (getSecretStore().isEncryptionAvailable()) {
    try {
      return getSecretStore().decryptString(raw)
    } catch {
      const plaintext = raw.toString('utf8')
      if (looksLikeCookieHeader(plaintext)) {
        return plaintext
      }
      throw new Error('MiniMax session cookie could not be decrypted')
    }
  }
  const plaintext = raw.toString('utf8')
  if (looksLikeCookieHeader(plaintext)) {
    return plaintext
  }
  throw new Error('MiniMax session cookie could not be decrypted')
}

/** Inspect protection without decryption/keychain prompts; legacy files use the reader's sniff. */
export async function getMiniMaxSessionCookieProtection(): Promise<SecretAtRestProtection | null> {
  return inCredentialFileOrder(`${getMiniMaxCookiePath()}.mutation`, async () => {
    const cookiePath = getMiniMaxCookiePath()
    if (!(await credentialFileExists(cookiePath))) {
      return null
    }
    try {
      const raw = await readFile(cookiePath)
      const envelope = decodeCookieEnvelope(raw)
      if (envelope) {
        return envelope.kind === 'plaintext' ? 'plaintext' : 'sealed'
      }
      return looksLikeCookieHeader(raw.toString('utf8')) ? 'plaintext' : 'sealed'
    } catch {
      return null
    }
  })
}

export async function hasMiniMaxSessionCookie(): Promise<boolean> {
  return inCredentialFileOrder(`${getMiniMaxCookiePath()}.mutation`, async () => {
    const keyPath = getMiniMaxCookiePath()
    if (!(await credentialFileExists(keyPath))) {
      return false
    }
    try {
      await hardenCredentialFile(keyPath)
    } catch (error) {
      if (!warnedMiniMaxCookieStatusHardenFailure) {
        warnedMiniMaxCookieStatusHardenFailure = true
        console.warn('[minimax] Failed to harden MiniMax cookie file while checking status', error)
      }
    }
    return true
  })
}

export async function saveMiniMaxSessionCookie(cookie: string): Promise<void> {
  return inCredentialFileOrder(`${getMiniMaxCookiePath()}.mutation`, async () => {
    const trimmed = cookie.trim()
    if (!trimmed) {
      throw new Error('MiniMax session cookie is required')
    }
    if (getSecretStore().isEncryptionAvailable()) {
      await writeSecureFile(
        getMiniMaxCookiePath(),
        encodeCookieEnvelope('encrypted', getSecretStore().encryptString(trimmed))
      )
      cachedMiniMaxCookie = trimmed
      return
    }
    console.warn(
      '[minimax] safeStorage encryption unavailable — storing MiniMax cookie in plaintext'
    )
    await writeSecureFile(
      getMiniMaxCookiePath(),
      encodeCookieEnvelope('plaintext', Buffer.from(trimmed, 'utf8'))
    )
    cachedMiniMaxCookie = trimmed
  })
}

export async function readMiniMaxSessionCookie(): Promise<string | null> {
  return inCredentialFileOrder(`${getMiniMaxCookiePath()}.mutation`, async () => {
    if (cachedMiniMaxCookie !== null) {
      return cachedMiniMaxCookie
    }
    const keyPath = getMiniMaxCookiePath()
    if (!(await credentialFileExists(keyPath))) {
      return null
    }
    // Keep permission failures outside decryption handling so they retain their actual diagnosis.
    try {
      await hardenCredentialFile(keyPath)
    } catch (error) {
      console.warn('[minimax] Failed to harden MiniMax cookie file while reading', error)
    }
    try {
      const raw = await readFile(keyPath)
      const envelope = decodeCookieEnvelope(raw)
      cachedMiniMaxCookie = envelope ? readEnvelope(envelope) : readLegacyCookie(raw)
      return cachedMiniMaxCookie
    } catch (error) {
      console.error('[minimax] failed to decode/decrypt session cookie', error)
      throw new Error('MiniMax session cookie could not be decrypted')
    }
  })
}

export async function clearMiniMaxSessionCookie(): Promise<void> {
  return inCredentialFileOrder(`${getMiniMaxCookiePath()}.mutation`, async () => {
    cachedMiniMaxCookie = null
    await rm(getMiniMaxCookiePath(), { force: true })
  })
}
