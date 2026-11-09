import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, rmSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

/** A JSON file an older build may have written, before its rows moved into SQLite. */
export type LegacyJsonSource =
  | { kind: 'absent' }
  | { kind: 'unreadable'; error: unknown }
  | { kind: 'read'; text: string; receipt: string }

/** `receipt` identifies these exact bytes, so a finished import is recognised next start. */
export function readLegacyJsonSource(path: string): LegacyJsonSource {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    return isDefinitiveAbsence(error) ? { kind: 'absent' } : { kind: 'unreadable', error }
  }
  try {
    const { mtimeMs } = fstatSync(fd)
    const bytes = readFileSync(fd)
    const hash = createHash('sha256').update(bytes).digest('hex')
    return {
      kind: 'read',
      text: bytes.toString('utf8'),
      receipt: `${bytes.length}:${Math.floor(mtimeMs)}:${hash}`
    }
  } catch (error) {
    return { kind: 'unreadable', error }
  } finally {
    closeSync(fd)
  }
}

/** Removes the file only while it is still the import's source, never a newer rewrite. */
export function removeImportedLegacyJsonSource(path: string, receipt: string): void {
  const current = readLegacyJsonSource(path)
  if (current.kind !== 'read' || current.receipt !== receipt) {
    return
  }
  try {
    rmSync(path, { force: true })
  } catch {
    // The stored receipt marks it imported, so a leftover file cannot shadow newer rows.
  }
}
