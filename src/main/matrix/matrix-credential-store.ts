import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken
} from '../integration-credential-file'

// Why: the Matrix access token is the relay account's login. It stays encrypted
// via safeStorage at ~/.orca/matrix-token.enc and is never written into settings,
// mirroring src/main/linear/client.ts so both integrations share one keychain
// contract and the same decrypt-failure semantics.

let cachedToken: string | null = null
let tokenLoadedFromDisk = false

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getTokenPath(): string {
  return join(getOrcaDir(), 'matrix-token.enc')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function storeMatrixToken(token: string): void {
  ensureOrcaDir()
  const path = getTokenPath()
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(path, safeStorage.encryptString(token), { mode: 0o600 })
  } else {
    // Why a plaintext fallback (mode 0600) rather than failing: some real Orca
    // hosts have no usable OS keychain — e.g. an XFCE/NoMachine session whose
    // D-Bus has no unlocked Secret Service, where Electron's safeStorage reports
    // unavailable (and its basic_text backend also reports unavailable on modern
    // Electron). Refusing would make the adapter unusable there. This mirrors the
    // existing linear/jira behavior; on a single-user, tailscale-only host a 0600
    // file readable only by the user is the accepted trade for a revocable relay
    // token. The warning keeps the downgrade visible.
    console.warn('[matrix] safeStorage unavailable — storing token at 0600 plaintext')
    writeFileSync(path, token, { encoding: 'utf-8', mode: 0o600 })
  }
  cachedToken = token
  tokenLoadedFromDisk = true
}

// Returns the decrypted token, or null when no token is stored. Throws
// CredentialDecryptionError when ciphertext exists but cannot be decrypted (e.g.
// the user denied the OS keychain prompt after an app re-sign) so the renderer
// can prompt a reconnect instead of treating it as "not connected".
export function readMatrixToken(): string | null {
  if (cachedToken !== null) {
    return cachedToken
  }
  if (tokenLoadedFromDisk) {
    return null
  }
  const path = getTokenPath()
  if (!existsSync(path)) {
    tokenLoadedFromDisk = true
    return null
  }
  const raw = readFileSync(path)
  const token = readStoredCredentialToken('Matrix', raw)
  cachedToken = token
  tokenLoadedFromDisk = true
  return token
}

export function clearMatrixToken(): void {
  cachedToken = null
  tokenLoadedFromDisk = true
  try {
    unlinkSync(getTokenPath())
  } catch {
    // File may not exist — safe to ignore.
  }
}

export function hasMatrixToken(): boolean {
  if (cachedToken !== null) {
    return true
  }
  return credentialFileHasContent(getTokenPath())
}

// Re-export so callers can branch on a decrypt failure without importing the
// shared credential module directly.
export { CredentialDecryptionError }
