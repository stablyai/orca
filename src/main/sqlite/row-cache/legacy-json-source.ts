import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'

/** A JSON file an older build may have written, before its rows moved into SQLite. */
export type LegacyJsonSource =
  | { kind: 'absent' }
  /** Present but not readable now (permissions, a Windows lock): neither absent nor imported. */
  | { kind: 'unreadable'; error: unknown }
  | { kind: 'read'; text: string; receipt: string }

/**
 * One-shot startup read. `receipt` is the hash of these exact bytes (not their mtime, so a
 * copied or restored leftover is still recognised as already imported).
 */
export function readLegacyJsonSource(path: string): LegacyJsonSource {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (error) {
    return isDefinitiveAbsence(error) ? { kind: 'absent' } : { kind: 'unreadable', error }
  }
  return {
    kind: 'read',
    text: bytes.toString('utf8'),
    receipt: createHash('sha256').update(bytes).digest('hex')
  }
}

/**
 * Removes the file only while it still holds the bytes `receipt` names, never a rewrite by
 * another build since. One-shot: after the import commits, or when its bytes were rejected.
 */
export function removeLegacyJsonSource(path: string, receipt: string): void {
  const current = readLegacyJsonSource(path)
  if (current.kind !== 'read' || current.receipt !== receipt) {
    return
  }
  try {
    rmSync(path, { force: true })
  } catch (error) {
    // A committed receipt marks it imported, so a leftover file cannot shadow newer rows.
    console.warn('[sqlite] Could not remove a migrated legacy JSON file:', error)
  }
}
