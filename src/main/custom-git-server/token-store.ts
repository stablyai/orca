import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSecretStore } from '../../shared/secret-store'
import {
  CredentialDecryptionError,
  credentialFileHasContent,
  readStoredCredentialToken
} from '../integration-credential-file'
import { getOrcaDir } from './server-config-store'

// Why: safeStorage / credential I/O is isolated here so the electron dependency
// stays out of forge-provider detection and other unrelated import graphs.

const cachedTokens = new Map<string, string>()
// Why: decrypt failures are recorded per server so status polling can report a
// failing read without re-hitting the keychain on every poll.
const credentialErrors = new Map<string, string>()

/** @internal - exposed for tests only */
export function _resetCustomGitServerTokenCache(): void {
  cachedTokens.clear()
  credentialErrors.clear()
}

function getTokenDir(): string {
  return join(getOrcaDir(), 'custom-git-server-tokens')
}

function getTokenPath(serverId: string): string {
  return join(getTokenDir(), `${Buffer.from(serverId).toString('base64url')}.enc`)
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function writeEncryptedToken(path: string, token: string): void {
  if (getSecretStore().isEncryptionAvailable()) {
    writeFileSync(path, getSecretStore().encryptString(token), { mode: 0o600 })
    return
  }
  console.warn('[custom-git-server] safeStorage encryption unavailable — storing token in plaintext')
  writeFileSync(path, token, { encoding: 'utf-8', mode: 0o600 })
}

/** Read the stored token; throws CredentialDecryptionError on undecryptable data. */
export function getCustomGitServerToken(serverId: string): string | null {
  const cached = cachedTokens.get(serverId)
  if (cached !== undefined) {
    return cached
  }
  const path = getTokenPath(serverId)
  if (!existsSync(path)) {
    return null
  }
  try {
    const token = readStoredCredentialToken('CustomGitServer', readFileSync(path))
    if (token) {
      cachedTokens.set(serverId, token)
    }
    credentialErrors.delete(serverId)
    return token
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      credentialErrors.set(serverId, error.message)
      throw error
    }
    return null
  }
}

/** Encrypt and persist a server's token, updating the cache. */
export function saveCustomGitServerToken(serverId: string, token: string): void {
  ensureDir(getOrcaDir())
  ensureDir(getTokenDir())
  writeEncryptedToken(getTokenPath(serverId), token)
  cachedTokens.set(serverId, token)
  credentialErrors.delete(serverId)
}

/** Remove a server's stored token from disk and cache. */
export function deleteCustomGitServerToken(serverId: string): void {
  try {
    unlinkSync(getTokenPath(serverId))
  } catch (error) {
    // Why: only a missing file is safe to ignore. Surface any other failure
    // (locked file, permissions) instead of leaving an orphaned token on disk
    // while the caller believes it was removed.
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      throw error
    }
  }
  cachedTokens.delete(serverId)
  credentialErrors.delete(serverId)
}

/** Whether a token is stored for this server (no decryption). */
export function hasStoredCustomGitServerToken(serverId: string): boolean {
  return cachedTokens.has(serverId) || credentialFileHasContent(getTokenPath(serverId))
}
