import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, net, safeStorage } from 'electron'
import type { AntigravityAccountSummary } from '../../shared/rate-limit-types'
import type { GeminiCredentials } from './gemini-oauth-sources'

// Why: `agy` is single-account — it keeps one Google OAuth token in the OS
// keyring, replaced on each re-login. To offer multiple Antigravity accounts in
// the status bar, Orca maintains its own account store: it snapshots the OAuth
// credentials for each Google account the user has signed into and lets the
// user switch between them. Credentials are encrypted at rest with Electron's
// safeStorage (OS-backed); only account metadata (id, email) is kept in clear.
const STORE_DIR_NAME = 'antigravity-accounts'
const STORE_FILE_NAME = 'accounts.json'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const API_TIMEOUT_MS = 10_000

type StoredAccount = {
  id: string
  email: string
  /** base64 safeStorage ciphertext of the JSON GeminiCredentials, or plaintext JSON fallback. */
  credential: string
  encrypted: boolean
}

type AccountStoreFile = {
  activeAccountId: string | null
  accounts: StoredAccount[]
}

/** Directory holding the account store, under Electron's userData path. */
function storeDir(): string {
  return join(app.getPath('userData'), STORE_DIR_NAME)
}

/** Full path to the account store JSON file. */
function storePath(): string {
  return join(storeDir(), STORE_FILE_NAME)
}

/**
 * Load the on-disk store, returning an empty store when absent or unreadable.
 * Fully guarded (incl. resolving the userData path) so a store failure can never
 * propagate into the rate-limit fetch cycle that reads it synchronously.
 */
function loadStore(): AccountStoreFile {
  try {
    const path = storePath()
    if (!existsSync(path)) {
      return { activeAccountId: null, accounts: [] }
    }
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AccountStoreFile>
    return {
      activeAccountId: typeof parsed.activeAccountId === 'string' ? parsed.activeAccountId : null,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
    }
  } catch {
    return { activeAccountId: null, accounts: [] }
  }
}

/** Persist the store atomically (0600), creating the directory as needed. */
function saveStore(store: AccountStoreFile): void {
  mkdirSync(storeDir(), { recursive: true })
  const tmp = `${storePath()}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 })
  // rename is atomic on the same volume; fall back to a direct write on failure.
  try {
    renameSync(tmp, storePath())
  } catch {
    writeFileSync(storePath(), JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 })
  }
}

/** Encrypt credentials with safeStorage (base64), or fall back to plain JSON when unavailable. */
function encryptCredential(creds: GeminiCredentials): string {
  const json = JSON.stringify(creds)
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(json).toString('base64')
  }
  return json
}

/** Decrypt a stored account's credentials; returns null when the blob is invalid. */
function decryptCredential(account: StoredAccount): GeminiCredentials | null {
  try {
    const raw = account.encrypted
      ? safeStorage.decryptString(Buffer.from(account.credential, 'base64'))
      : account.credential
    const parsed = JSON.parse(raw) as GeminiCredentials
    if (typeof parsed.access_token === 'string' && typeof parsed.expiry_date === 'number') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/** Fetch the Google account email for an access token via the OpenID userinfo endpoint. */
export async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await net.fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    if (!res.ok) {
      return null
    }
    const data = (await res.json()) as { email?: unknown }
    return typeof data.email === 'string' ? data.email : null
  } catch {
    return null
  }
}

/** List all stored accounts with their active flag, for the status-bar switcher. */
export function listAccounts(): AntigravityAccountSummary[] {
  const store = loadStore()
  return store.accounts.map((a) => ({
    id: a.id,
    email: a.email,
    isActive: a.id === store.activeAccountId
  }))
}

/** The id of the active account, or null when none is stored. */
export function getActiveAccountId(): string | null {
  return loadStore().activeAccountId
}

/** Decrypt and return an account's credentials, or null. */
export function getAccountCredentials(id: string): GeminiCredentials | null {
  const account = loadStore().accounts.find((a) => a.id === id)
  return account ? decryptCredential(account) : null
}

/** Credentials for the active account, or null when none is stored. */
export function getActiveAccountCredentials(): GeminiCredentials | null {
  const store = loadStore()
  if (!store.activeAccountId) {
    return null
  }
  return getAccountCredentials(store.activeAccountId)
}

/**
 * Add (or refresh) an account keyed by email, encrypting its credentials. When
 * `makeActive` is true (or it is the first account), it becomes the active one.
 * Returns the account id.
 */
export function upsertAccount(email: string, creds: GeminiCredentials, makeActive = false): string {
  const store = loadStore()
  const existing = store.accounts.find((a) => a.email === email)
  const credential = encryptCredential(creds)
  const encrypted = safeStorage.isEncryptionAvailable()
  if (existing) {
    existing.credential = credential
    existing.encrypted = encrypted
    if (makeActive) {
      store.activeAccountId = existing.id
    }
    saveStore(store)
    return existing.id
  }
  const id = randomUUID()
  store.accounts.push({ id, email, credential, encrypted })
  if (makeActive || store.accounts.length === 1) {
    store.activeAccountId = id
  }
  saveStore(store)
  return id
}

/** Set the active account. No-op when the id is unknown. */
export function setActiveAccount(id: string): boolean {
  const store = loadStore()
  if (!store.accounts.some((a) => a.id === id)) {
    return false
  }
  store.activeAccountId = id
  saveStore(store)
  return true
}

/** Remove an account; re-points the active account to the first remaining one. */
export function removeAccount(id: string): void {
  const store = loadStore()
  store.accounts = store.accounts.filter((a) => a.id !== id)
  if (store.activeAccountId === id) {
    store.activeAccountId = store.accounts[0]?.id ?? null
  }
  saveStore(store)
}
