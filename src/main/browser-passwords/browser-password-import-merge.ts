import { randomUUID } from 'node:crypto'
import type { BrowserPasswordImportSummary } from '../../shared/browser-passwords-types'
import { toBrowserPasswordOrigin } from './browser-password-origin'
import {
  sealBrowserVaultValue,
  unsealBrowserPassword,
  type BrowserPasswordStoreResult,
  type BrowserPasswordVaultState
} from './browser-password-vault-file'

export type BrowserPasswordImportRow = {
  /** Any URL; reduced to its origin, and rejected unless http(s). */
  origin: string
  username: string
  password: string
  note?: string
  createdAt?: number
}

/**
 * Adds rows that are new for their origin and username. A saved login with the same password is a
 * duplicate; with a different one it is a conflict and the saved password is kept.
 * `undecryptable` stays 0 for the Chromium reader to fill in.
 */
export function mergeBrowserPasswordImportRows(
  state: BrowserPasswordVaultState,
  rows: readonly BrowserPasswordImportRow[],
  now: number
): BrowserPasswordStoreResult<{
  state: BrowserPasswordVaultState
  summary: BrowserPasswordImportSummary
}> {
  const summary: BrowserPasswordImportSummary = {
    imported: 0,
    duplicates: 0,
    conflicts: 0,
    invalid: 0,
    undecryptable: 0
  }
  const entries = [...state.index.entries]
  const passwords = { ...state.passwords }
  const notes = { ...state.notes }
  const keyOf = (origin: string, username: string): string => JSON.stringify([origin, username])
  const idByKey = new Map(entries.map((entry) => [keyOf(entry.origin, entry.username), entry.id]))
  // Plaintext of this batch's own rows, so a repeated row compares without unsealing.
  const importedPasswords = new Map<string, string>()

  for (const row of rows) {
    const origin = toBrowserPasswordOrigin(row.origin)
    if (!origin || !row.password) {
      summary.invalid += 1
      continue
    }
    const key = keyOf(origin, row.username)
    const existingId = idByKey.get(key)
    if (existingId !== undefined) {
      const batchPassword = importedPasswords.get(existingId)
      const saved =
        batchPassword === undefined
          ? unsealBrowserPassword(state, existingId)
          : { ok: true as const, value: batchPassword }
      if (!saved.ok) {
        return saved
      }
      if (saved.value === row.password) {
        summary.duplicates += 1
      } else {
        summary.conflicts += 1
      }
      continue
    }
    const id = randomUUID()
    const sealed = sealBrowserVaultValue({ kind: 'password', id, origin }, row.password)
    if (!sealed.ok) {
      return sealed
    }
    const createdAt =
      row.createdAt !== undefined && Number.isFinite(row.createdAt) && row.createdAt > 0
        ? Math.min(row.createdAt, now)
        : now
    entries.push({
      id,
      origin,
      username: row.username,
      createdAt,
      updatedAt: now,
      lastUsedAt: null
    })
    passwords[id] = sealed.value
    if (row.note) {
      const sealedNote = sealBrowserVaultValue({ kind: 'note', id, origin }, row.note)
      if (!sealedNote.ok) {
        return sealedNote
      }
      notes[id] = sealedNote.value
    }
    idByKey.set(key, id)
    importedPasswords.set(id, row.password)
    summary.imported += 1
  }
  return {
    ok: true,
    value: { state: { index: { ...state.index, entries }, passwords, notes }, summary }
  }
}
