import { randomUUID } from 'node:crypto'
import type {
  BrowserPasswordEntrySummary,
  BrowserPasswordImportSummary,
  BrowserPasswordsAvailability
} from '../../shared/browser-passwords-types'
import {
  mergeBrowserPasswordImportRows,
  type BrowserPasswordImportRow
} from './browser-password-import-merge'
import {
  matchBrowserPasswordEntries,
  toBrowserPasswordOrigin,
  type BrowserPasswordMatches
} from './browser-password-origin'
import {
  browserPasswordProtectionFailure,
  readBrowserPasswordVault,
  removeBrowserPasswordVaultFile,
  sealBrowserVaultValue,
  unsealBrowserNote,
  unsealBrowserPassword,
  withoutBrowserPasswordEntry,
  writeBrowserPasswordVault,
  type BrowserPasswordStoreResult,
  type BrowserPasswordVaultState
} from './browser-password-vault-file'

export type BrowserPasswordAddResult = {
  entry: BrowserPasswordEntrySummary
  /** False when an entry for the same origin and username was updated instead. */
  created: boolean
}

type EntryChange = Partial<BrowserPasswordEntrySummary> & {
  sealedPassword?: string
  /** null removes the note. */
  sealedNote?: string | null
}

/**
 * One browser profile's saved logins. Fails closed like plugin-secrets-store: with no real
 * protection, or a vault it cannot read or unseal, every operation reports unavailable and the
 * file is never rewritten. The index is cached after the first read; passwords stay sealed.
 */
export class BrowserPasswordStore {
  private readonly filePath: string
  private readonly now: () => number
  private cache: BrowserPasswordVaultState | null = null

  constructor(filePath: string, options: { now?: () => number } = {}) {
    this.filePath = filePath
    this.now = options.now ?? Date.now
  }

  private load(): BrowserPasswordStoreResult<BrowserPasswordVaultState> {
    // Checked every call: protection can be lost after the cache was filled.
    const failure = browserPasswordProtectionFailure()
    if (failure) {
      return failure
    }
    if (this.cache) {
      return { ok: true, value: this.cache }
    }
    const read = readBrowserPasswordVault(this.filePath)
    if (read.ok) {
      this.cache = read.value
    }
    return read
  }

  /** The cache moves only once the file holds `next`. */
  private save(next: BrowserPasswordVaultState): BrowserPasswordStoreResult<true> {
    const written = writeBrowserPasswordVault(this.filePath, next)
    if (written.ok) {
      this.cache = next
    }
    return written
  }

  private updateEntry(
    id: string,
    change: (
      entry: BrowserPasswordEntrySummary,
      state: BrowserPasswordVaultState
    ) => BrowserPasswordStoreResult<EntryChange>
  ): BrowserPasswordStoreResult<BrowserPasswordEntrySummary> {
    const loaded = this.load()
    if (!loaded.ok) {
      return loaded
    }
    const state = loaded.value
    const current = state.index.entries.find((entry) => entry.id === id)
    if (!current) {
      return { ok: false, reason: 'not-found' }
    }
    const changed = change(current, state)
    if (!changed.ok) {
      return changed
    }
    const { sealedPassword, sealedNote, ...fields } = changed.value
    const updated = { ...current, ...fields }
    const notes = { ...state.notes }
    if (sealedNote === null) {
      delete notes[id]
    } else if (sealedNote !== undefined) {
      notes[id] = sealedNote
    }
    const saved = this.save({
      notes,
      index: {
        ...state.index,
        entries: state.index.entries.map((entry) => (entry.id === id ? updated : entry))
      },
      passwords:
        sealedPassword === undefined
          ? state.passwords
          : { ...state.passwords, [id]: sealedPassword }
    })
    return saved.ok ? { ok: true, value: updated } : saved
  }

  availability(): BrowserPasswordsAvailability {
    const loaded = this.load()
    if (loaded.ok) {
      return { available: true }
    }
    return {
      available: false,
      reason: loaded.reason === 'unavailable' ? loaded.message : loaded.reason
    }
  }

  list(): BrowserPasswordStoreResult<BrowserPasswordEntrySummary[]> {
    const loaded = this.load()
    return loaded.ok ? { ok: true, value: [...loaded.value.index.entries] } : loaded
  }

  findForOrigin(
    pageOrigin: string
  ): BrowserPasswordStoreResult<BrowserPasswordMatches<BrowserPasswordEntrySummary>> {
    const loaded = this.load()
    return loaded.ok
      ? { ok: true, value: matchBrowserPasswordEntries(loaded.value.index.entries, pageOrigin) }
      : loaded
  }

  getPassword(id: string): BrowserPasswordStoreResult<string> {
    const loaded = this.load()
    return loaded.ok ? unsealBrowserPassword(loaded.value, id) : loaded
  }

  getNote(id: string): BrowserPasswordStoreResult<string> {
    const loaded = this.load()
    return loaded.ok ? unsealBrowserNote(loaded.value, id) : loaded
  }

  updateNote(id: string, note: string): BrowserPasswordStoreResult<BrowserPasswordEntrySummary> {
    return this.updateEntry(id, (current) => {
      if (!note) {
        return { ok: true, value: { updatedAt: this.now(), sealedNote: null } }
      }
      const sealed = sealBrowserVaultValue({ kind: 'note', id, origin: current.origin }, note)
      return sealed.ok
        ? { ok: true, value: { updatedAt: this.now(), sealedNote: sealed.value } }
        : sealed
    })
  }

  add(input: {
    origin: string
    username: string
    password: string
  }): BrowserPasswordStoreResult<BrowserPasswordAddResult> {
    const origin = toBrowserPasswordOrigin(input.origin)
    if (!origin) {
      return { ok: false, reason: 'invalid-origin' }
    }
    if (!input.password) {
      return { ok: false, reason: 'invalid-password' }
    }
    const loaded = this.load()
    if (!loaded.ok) {
      return loaded
    }
    const state = loaded.value
    const existing = state.index.entries.find(
      (entry) => entry.origin === origin && entry.username === input.username
    )
    if (existing) {
      const updated = this.updatePassword(existing.id, input.password)
      return updated.ok ? { ok: true, value: { entry: updated.value, created: false } } : updated
    }
    const id = randomUUID()
    const sealed = sealBrowserVaultValue({ kind: 'password', id, origin }, input.password)
    if (!sealed.ok) {
      return sealed
    }
    const now = this.now()
    const entry: BrowserPasswordEntrySummary = {
      id,
      origin,
      username: input.username,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null
    }
    const saved = this.save({
      index: { ...state.index, entries: [...state.index.entries, entry] },
      passwords: { ...state.passwords, [entry.id]: sealed.value },
      notes: state.notes
    })
    return saved.ok ? { ok: true, value: { entry, created: true } } : saved
  }

  updatePassword(
    id: string,
    password: string
  ): BrowserPasswordStoreResult<BrowserPasswordEntrySummary> {
    if (!password) {
      return { ok: false, reason: 'invalid-password' }
    }
    return this.updateEntry(id, (current) => {
      const sealed = sealBrowserVaultValue(
        { kind: 'password', id, origin: current.origin },
        password
      )
      return sealed.ok
        ? { ok: true, value: { updatedAt: this.now(), sealedPassword: sealed.value } }
        : sealed
    })
  }

  updateUsername(
    id: string,
    username: string
  ): BrowserPasswordStoreResult<BrowserPasswordEntrySummary> {
    return this.updateEntry(id, (current, state) =>
      state.index.entries.some(
        (entry) => entry.id !== id && entry.origin === current.origin && entry.username === username
      )
        ? { ok: false, reason: 'duplicate' }
        : { ok: true, value: { username, updatedAt: this.now() } }
    )
  }

  markUsed(id: string): BrowserPasswordStoreResult<BrowserPasswordEntrySummary> {
    return this.updateEntry(id, () => ({ ok: true, value: { lastUsedAt: this.now() } }))
  }

  remove(id: string): BrowserPasswordStoreResult<true> {
    const loaded = this.load()
    if (!loaded.ok) {
      return loaded
    }
    if (!loaded.value.index.entries.some((entry) => entry.id === id)) {
      return { ok: false, reason: 'not-found' }
    }
    return this.save(withoutBrowserPasswordEntry(loaded.value, id))
  }

  isNever(origin: string): BrowserPasswordStoreResult<boolean> {
    const loaded = this.load()
    if (!loaded.ok) {
      return loaded
    }
    const normalized = toBrowserPasswordOrigin(origin)
    return {
      ok: true,
      value: normalized !== null && loaded.value.index.neverOrigins.includes(normalized)
    }
  }

  addNever(origin: string): BrowserPasswordStoreResult<true> {
    return this.changeNever(origin, (origins, normalized) =>
      origins.includes(normalized) ? null : [...origins, normalized]
    )
  }

  removeNever(origin: string): BrowserPasswordStoreResult<true> {
    return this.changeNever(origin, (origins, normalized) =>
      origins.includes(normalized) ? origins.filter((o) => o !== normalized) : null
    )
  }

  /** `change` returns null when there is nothing to write. */
  private changeNever(
    origin: string,
    change: (origins: string[], normalized: string) => string[] | null
  ): BrowserPasswordStoreResult<true> {
    const normalized = toBrowserPasswordOrigin(origin)
    if (!normalized) {
      return { ok: false, reason: 'invalid-origin' }
    }
    const loaded = this.load()
    if (!loaded.ok) {
      return loaded
    }
    const state = loaded.value
    const neverOrigins = change(state.index.neverOrigins, normalized)
    return neverOrigins
      ? this.save({ ...state, index: { ...state.index, neverOrigins } })
      : { ok: true, value: true }
  }

  listNever(): BrowserPasswordStoreResult<string[]> {
    const loaded = this.load()
    return loaded.ok ? { ok: true, value: [...loaded.value.index.neverOrigins] } : loaded
  }

  importRows(
    rows: readonly BrowserPasswordImportRow[]
  ): BrowserPasswordStoreResult<BrowserPasswordImportSummary> {
    const loaded = this.load()
    if (!loaded.ok) {
      return loaded
    }
    const merged = mergeBrowserPasswordImportRows(loaded.value, rows, this.now())
    if (!merged.ok) {
      return merged
    }
    const { state, summary } = merged.value
    const saved = summary.imported > 0 ? this.save(state) : null
    return saved && !saved.ok ? saved : { ok: true, value: summary }
  }

  /** For profile deletion: removes the vault whatever state it is in. */
  deleteFile(): BrowserPasswordStoreResult<true> {
    const removed = removeBrowserPasswordVaultFile(this.filePath)
    if (removed.ok) {
      this.cache = null
    }
    return removed
  }
}
