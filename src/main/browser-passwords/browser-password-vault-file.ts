import { readFileSync, rmSync } from 'node:fs'
import type { BrowserPasswordEntrySummary } from '../../shared/browser-passwords-types'
import { getSecretStore, hasSecretStore } from '../../shared/secret-store'
import { writeSecureFile } from '../../shared/secure-file'

/**
 * On-disk vault: usernames and sites sit in one sealed index; each password is sealed on its own
 * so a fill or reveal unseals exactly one. Sealing goes through the host's SecretStore.
 */

const VAULT_FORMAT = 'orca-browser-passwords-v1'

type PersistedVault = {
  version: 1
  format: typeof VAULT_FORMAT
  /** base64 sealed JSON of {@link BrowserPasswordVaultIndex}. */
  index: string
  /** entry id → base64 sealed password. */
  passwords: Record<string, string>
  /** entry id → base64 sealed note; absent in files written before notes existed. */
  notes?: Record<string, string>
}

export type BrowserPasswordVaultIndex = {
  entries: BrowserPasswordEntrySummary[]
  neverOrigins: string[]
}

export type BrowserPasswordVaultState = {
  index: BrowserPasswordVaultIndex
  /** entry id → base64 sealed password, still sealed in memory. */
  passwords: Record<string, string>
  /** entry id → base64 sealed note, sealed apart from the index like passwords. */
  notes: Record<string, string>
}

export type BrowserPasswordStoreFailure =
  | { ok: false; reason: 'unavailable'; message: string }
  | { ok: false; reason: 'not-found' }
  /** An origin that is not http(s), an empty password, or a username already saved for the site. */
  | { ok: false; reason: 'invalid-origin' | 'invalid-password' | 'duplicate' }

export type BrowserPasswordStoreResult<T> = { ok: true; value: T } | BrowserPasswordStoreFailure

const UNREADABLE_MESSAGE = 'Saved passwords exist but could not be read.'
const UNSEALABLE_MESSAGE = 'Saved passwords exist but could not be decrypted on this device.'
const ENCRYPTION_UNAVAILABLE_MESSAGE = 'OS-backed encryption is unavailable.'

export function browserPasswordsUnavailable(message: string): BrowserPasswordStoreFailure {
  return { ok: false, reason: 'unavailable', message }
}

/** Null when sealing is real; otherwise the reason, with the protection gap verbatim for Settings. */
export function browserPasswordProtectionFailure(): BrowserPasswordStoreFailure | null {
  if (!hasSecretStore()) {
    return browserPasswordsUnavailable('Secure storage is not ready.')
  }
  const store = getSecretStore()
  if (!store.isEncryptionAvailable()) {
    return browserPasswordsUnavailable(ENCRYPTION_UNAVAILABLE_MESSAGE)
  }
  const gap = store.describeProtectionGap()
  return gap === null ? null : browserPasswordsUnavailable(gap)
}

/** Whose value a ciphertext is. Sealed with it, so a value copied under another entry won't open. */
export type BrowserVaultValueBinding = {
  kind: 'password' | 'note'
  id: string
  origin: string
}

export function sealBrowserVaultValue(
  binding: BrowserVaultValueBinding,
  plain: string
): BrowserPasswordStoreResult<string> {
  try {
    const payload = JSON.stringify([binding.kind, binding.id, binding.origin, plain])
    return { ok: true, value: getSecretStore().encryptString(payload).toString('base64') }
  } catch {
    return browserPasswordsUnavailable(ENCRYPTION_UNAVAILABLE_MESSAGE)
  }
}

export function unsealBrowserPassword(
  state: BrowserPasswordVaultState,
  id: string
): BrowserPasswordStoreResult<string> {
  return unsealVaultValue(state, 'password', id, state.passwords[id])
}

/** An entry with no note reads back as ''. */
export function unsealBrowserNote(
  state: BrowserPasswordVaultState,
  id: string
): BrowserPasswordStoreResult<string> {
  return id in state.notes
    ? unsealVaultValue(state, 'note', id, state.notes[id])
    : { ok: true, value: '' }
}

function unsealVaultValue(
  state: BrowserPasswordVaultState,
  kind: BrowserVaultValueBinding['kind'],
  id: string,
  sealed: string | undefined
): BrowserPasswordStoreResult<string> {
  const entry = state.index.entries.find((candidate) => candidate.id === id)
  if (sealed === undefined || !entry) {
    return { ok: false, reason: 'not-found' }
  }
  try {
    const payload: unknown = JSON.parse(
      getSecretStore().decryptString(Buffer.from(sealed, 'base64'))
    )
    if (
      Array.isArray(payload) &&
      payload.length === 4 &&
      payload[0] === kind &&
      payload[1] === id &&
      payload[2] === entry.origin &&
      typeof payload[3] === 'string'
    ) {
      return { ok: true, value: payload[3] }
    }
  } catch {
    // Falls through to unavailable, like a value bound to another entry.
  }
  return browserPasswordsUnavailable(UNSEALABLE_MESSAGE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEntrySummary(value: unknown): value is BrowserPasswordEntrySummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.origin === 'string' &&
    typeof value.username === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    (value.lastUsedAt === null || typeof value.lastUsedAt === 'number')
  )
}

function parseIndex(json: string): BrowserPasswordVaultIndex | null {
  const value: unknown = JSON.parse(json)
  if (
    !isRecord(value) ||
    !Array.isArray(value.entries) ||
    !value.entries.every(isEntrySummary) ||
    !Array.isArray(value.neverOrigins) ||
    !value.neverOrigins.every((origin) => typeof origin === 'string')
  ) {
    return null
  }
  return { entries: value.entries, neverOrigins: value.neverOrigins }
}

function parsePersistedVault(text: string): PersistedVault | null {
  const value: unknown = JSON.parse(text)
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.format !== VAULT_FORMAT ||
    typeof value.index !== 'string' ||
    !isRecord(value.passwords)
  ) {
    return null
  }
  const passwords = readSealedMap(value.passwords)
  const notes = value.notes === undefined ? {} : readSealedMap(value.notes)
  return passwords && notes
    ? { version: 1, format: VAULT_FORMAT, index: value.index, passwords, notes }
    : null
}

function readSealedMap(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null
  }
  const map: Record<string, string> = {}
  for (const [id, sealed] of Object.entries(value)) {
    if (typeof sealed !== 'string') {
      return null
    }
    map[id] = sealed
  }
  return map
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** A missing file is an empty vault; any other failure is unavailable, so callers never overwrite it. */
export function readBrowserPasswordVault(
  filePath: string
): BrowserPasswordStoreResult<BrowserPasswordVaultState> {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    // Wider than isUnreadableError on purpose: no read failure is evidence the vault is empty.
    return isMissingFileError(error)
      ? { ok: true, value: { index: { entries: [], neverOrigins: [] }, passwords: {}, notes: {} } }
      : browserPasswordsUnavailable(UNREADABLE_MESSAGE)
  }
  // Why corrupt also fails closed: rewriting it would destroy whatever logins it still holds.
  try {
    const persisted = parsePersistedVault(text)
    const index = persisted
      ? parseIndex(getSecretStore().decryptString(Buffer.from(persisted.index, 'base64')))
      : null
    return persisted && index
      ? { ok: true, value: { index, passwords: persisted.passwords, notes: persisted.notes ?? {} } }
      : browserPasswordsUnavailable(UNSEALABLE_MESSAGE)
  } catch {
    return browserPasswordsUnavailable(UNSEALABLE_MESSAGE)
  }
}

export function writeBrowserPasswordVault(
  filePath: string,
  state: BrowserPasswordVaultState
): BrowserPasswordStoreResult<true> {
  try {
    const persisted: PersistedVault = {
      version: 1,
      format: VAULT_FORMAT,
      index: getSecretStore().encryptString(JSON.stringify(state.index)).toString('base64'),
      passwords: state.passwords,
      notes: state.notes
    }
    writeSecureFile(filePath, JSON.stringify(persisted))
    return { ok: true, value: true }
  } catch (error) {
    return browserPasswordsUnavailable(`Could not save passwords: ${String(error)}`)
  }
}

/** `state` without one entry, its password and its note. */
export function withoutBrowserPasswordEntry(
  state: BrowserPasswordVaultState,
  id: string
): BrowserPasswordVaultState {
  const { [id]: _password, ...passwords } = state.passwords
  const { [id]: _note, ...notes } = state.notes
  return {
    index: { ...state.index, entries: state.index.entries.filter((entry) => entry.id !== id) },
    passwords,
    notes
  }
}

export function removeBrowserPasswordVaultFile(filePath: string): BrowserPasswordStoreResult<true> {
  try {
    rmSync(filePath, { force: true })
    return { ok: true, value: true }
  } catch (error) {
    return browserPasswordsUnavailable(`Could not delete saved passwords: ${String(error)}`)
  }
}
