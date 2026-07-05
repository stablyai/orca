import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MINIMAX_COOKIE_FILE = 'minimax-session-cookie.enc'
let cachedMiniMaxCookie: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getMiniMaxCookiePath(): string {
  return join(getOrcaDir(), MINIMAX_COOKIE_FILE)
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function hasMiniMaxSessionCookie(): boolean {
  return existsSync(getMiniMaxCookiePath())
}

export function saveMiniMaxSessionCookie(cookie: string): void {
  const trimmed = cookie.trim()
  if (!trimmed) {
    throw new Error('MiniMax session cookie is required')
  }
  ensureOrcaDir()
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(getMiniMaxCookiePath(), safeStorage.encryptString(trimmed), { mode: 0o600 })
    cachedMiniMaxCookie = trimmed
    return
  }
  console.warn('[minimax] safeStorage encryption unavailable — storing MiniMax cookie in plaintext')
  writeFileSync(getMiniMaxCookiePath(), trimmed, { encoding: 'utf8', mode: 0o600 })
  cachedMiniMaxCookie = trimmed
}

export function readMiniMaxSessionCookie(): string | null {
  if (cachedMiniMaxCookie !== null) {
    return cachedMiniMaxCookie
  }
  const keyPath = getMiniMaxCookiePath()
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    const raw = readFileSync(keyPath)
    cachedMiniMaxCookie = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    return cachedMiniMaxCookie
  } catch {
    throw new Error('MiniMax session cookie could not be decrypted')
  }
}

export function clearMiniMaxSessionCookie(): void {
  cachedMiniMaxCookie = null
  rmSync(getMiniMaxCookiePath(), { force: true })
}
