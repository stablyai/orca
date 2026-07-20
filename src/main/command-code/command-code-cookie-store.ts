import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'

const COOKIE_FILE = 'command-code-session-cookie.enc'
const COOKIE_ENVELOPE_PREFIX = 'orca-command-code-cookie:v1:'
let cachedCookie: string | null = null
let warnedHardenFailure = false

type CookieEnvelope = {
  kind: 'encrypted' | 'plaintext'
  payload: Buffer
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getCookiePath(): string {
  return join(getOrcaDir(), COOKIE_FILE)
}

function encodeCookieEnvelope(kind: CookieEnvelope['kind'], payload: Buffer): string {
  return `${COOKIE_ENVELOPE_PREFIX}${kind}:${payload.toString('base64')}`
}

function decodeCookieEnvelope(raw: Buffer): CookieEnvelope | null {
  const text = raw.toString('utf8')
  if (!text.startsWith(COOKIE_ENVELOPE_PREFIX)) {
    return null
  }
  const rest = text.slice(COOKIE_ENVELOPE_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator < 0) {
    throw new Error('Command Code session cookie could not be decrypted')
  }
  const kind = rest.slice(0, separator)
  if (kind !== 'encrypted' && kind !== 'plaintext') {
    throw new Error('Command Code session cookie could not be decrypted')
  }
  return {
    kind,
    payload: Buffer.from(rest.slice(separator + 1), 'base64')
  }
}

function readEnvelope(envelope: CookieEnvelope): string {
  if (envelope.kind === 'plaintext') {
    return envelope.payload.toString('utf8')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Command Code session cookie could not be decrypted')
  }
  return safeStorage.decryptString(envelope.payload)
}

// Why: migrates cookies saved before the envelope format existed. Older files
// hold raw bytes (safeStorage-encrypted or plaintext), so we sniff the content
// to tell the two apart rather than removing this as seemingly dead code.
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

function readLegacyCookie(raw: Buffer): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(raw)
    } catch {
      // fall through to plaintext heuristic below
    }
  }
  const plaintext = raw.toString('utf8')
  if (looksLikeCookieHeader(plaintext)) {
    return plaintext
  }
  throw new Error('Command Code session cookie could not be decrypted')
}

export function hasCommandCodeSessionCookie(): boolean {
  const keyPath = getCookiePath()
  if (!existsSync(keyPath)) {
    return false
  }
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    if (!warnedHardenFailure) {
      warnedHardenFailure = true
      console.warn('[command-code] Failed to harden cookie file while checking status', error)
    }
  }
  return true
}

export function saveCommandCodeSessionCookie(cookie: string): void {
  const trimmed = cookie.trim()
  if (!trimmed) {
    throw new Error('Command Code session cookie is required')
  }
  if (safeStorage.isEncryptionAvailable()) {
    writeSecureFile(
      getCookiePath(),
      encodeCookieEnvelope('encrypted', safeStorage.encryptString(trimmed))
    )
    cachedCookie = trimmed
    return
  }
  console.warn('[command-code] safeStorage encryption unavailable — storing cookie in plaintext')
  writeSecureFile(getCookiePath(), encodeCookieEnvelope('plaintext', Buffer.from(trimmed, 'utf8')))
  cachedCookie = trimmed
}

export function readCommandCodeSessionCookie(): string | null {
  if (cachedCookie !== null) {
    return cachedCookie
  }
  const keyPath = getCookiePath()
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    console.warn('[command-code] Failed to harden cookie file while reading', error)
  }
  try {
    const raw = readFileSync(keyPath)
    const envelope = decodeCookieEnvelope(raw)
    cachedCookie = envelope ? readEnvelope(envelope) : readLegacyCookie(raw)
    return cachedCookie
  } catch (error) {
    console.error('[command-code] failed to decode/decrypt session cookie', error)
    throw new Error('Command Code session cookie could not be decrypted')
  }
}

export function clearCommandCodeSessionCookie(): void {
  cachedCookie = null
  rmSync(getCookiePath(), { force: true })
}
