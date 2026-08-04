import { safeStorage } from 'electron'
import { rmSync } from 'node:fs'
import { writeSecureFile } from '../../shared/secure-file'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MemorySnapshot } from '../../shared/memory-snapshot'
import {
  classifyFilesystemSnapshotFailure,
  MemorySnapshotStore
} from '../rate-limits/memory-snapshot-store'
import { readSnapshotFileThroughFilesystemHost } from '../filesystem-host/filesystem-host-read-authority'

const MINIMAX_COOKIE_FILE = 'minimax-session-cookie.enc'
const COOKIE_ENVELOPE_PREFIX = 'orca-minimax-cookie:v1:'
const cookieSnapshot = new MemorySnapshotStore<string>()

type MiniMaxCookieEnvelope = {
  kind: 'encrypted' | 'plaintext'
  payload: Buffer
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getMiniMaxCookiePath(): string {
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
  if (separator < 0) {
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

function readEnvelope(envelope: MiniMaxCookieEnvelope): string {
  if (envelope.kind === 'plaintext') {
    return envelope.payload.toString('utf8')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('MiniMax session cookie could not be decrypted')
  }
  return safeStorage.decryptString(envelope.payload)
}

function readLegacyCookie(raw: Buffer): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(raw)
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

export function hasMiniMaxSessionCookie(): boolean {
  return cookieSnapshot.get().value !== null
}

export function getMiniMaxCredentialSnapshot(): MemorySnapshot<{ configured: true }> {
  const snapshot = cookieSnapshot.get()
  return {
    ...snapshot,
    value: snapshot.value === null ? null : { configured: true }
  }
}

export function saveMiniMaxSessionCookie(cookie: string): void {
  const trimmed = cookie.trim()
  if (!trimmed) {
    throw new Error('MiniMax session cookie is required')
  }
  let contents: string
  if (safeStorage.isEncryptionAvailable()) {
    contents = encodeCookieEnvelope('encrypted', safeStorage.encryptString(trimmed))
  } else {
    console.warn(
      '[minimax] safeStorage encryption unavailable — storing MiniMax cookie in plaintext'
    )
    contents = encodeCookieEnvelope('plaintext', Buffer.from(trimmed, 'utf8'))
  }
  try {
    writeSecureFile(getMiniMaxCookiePath(), contents)
  } catch (error) {
    cookieSnapshot.invalidate()
    throw error
  }
  cookieSnapshot.publishOwned({ value: trimmed, availability: 'ready' })
}

export function readMiniMaxSessionCookie(): string | null {
  return cookieSnapshot.getFreshValue()
}

export async function hydrateMiniMaxSessionCookie(): Promise<MemorySnapshot<{ configured: true }>> {
  await cookieSnapshot.refresh(async (fence) => {
    let raw: Buffer
    try {
      raw = await readSnapshotFileThroughFilesystemHost(getMiniMaxCookiePath(), 'minimax-cookie')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { value: null, availability: 'missing' }
      }
      throw error
    }
    if (!fence.isCurrent()) {
      return { value: null, availability: 'missing' }
    }
    const envelope = decodeCookieEnvelope(raw)
    return {
      value: envelope ? readEnvelope(envelope) : readLegacyCookie(raw),
      availability: 'ready'
    }
  }, classifyFilesystemSnapshotFailure)
  return getMiniMaxCredentialSnapshot()
}

export function clearMiniMaxSessionCookie(): void {
  rmSync(getMiniMaxCookiePath(), { force: true })
  cookieSnapshot.revoke()
}
