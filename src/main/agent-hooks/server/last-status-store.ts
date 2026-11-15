import { dirname, join } from 'node:path'

import { KeyedJsonRowCache, type KeyedJsonRow } from '../../sqlite/row-cache/keyed-json-row-cache'
import type { LastStatusFile } from './server-types'
import { assemble, LAST_STATUS_SCHEMA_VERSION, rowsOf } from './last-status-saved-rows'

export type SavedStatus = { document: unknown; source: 'legacy' | 'rows' }

export function lastStatusDatabasePath(legacyJsonPath: string): string {
  return join(dirname(legacyJsonPath), 'last-status.db')
}

/**
 * Restart cache for agent status, one row per pane, per authority commitment, plus the exit
 * list: a save rewrites only rows whose content changed. It runs on the main thread, so it
 * never waits on another connection's lock beyond the caller's small bound.
 */
export class LastStatusStore {
  private readonly cache: KeyedJsonRowCache
  private savedRows: KeyedJsonRow[] = []
  /** The older build's file read at startup, until hydration admits or rejects it. */
  private legacyReceipt: string | undefined
  private pendingImport: string | undefined
  /**
   * Set when the saved rows or an older build's file could not be read at startup. The session
   * then neither writes nor deletes, so rows it never read and a file it never imported both
   * survive for a later start. Authority commitments are then not persisted this session, as
   * when the JSON file was unwritable before.
   */
  private disabled = false

  constructor(legacyJsonPath: string) {
    this.cache = new KeyedJsonRowCache(lastStatusDatabasePath(legacyJsonPath), {
      schemaVersion: LAST_STATUS_SCHEMA_VERSION,
      busyTimeoutMs: 0,
      legacyPath: legacyJsonPath
    })
  }

  get isDisabled(): boolean {
    return this.disabled
  }

  /** The saved document (unvalidated) and where it came from, or undefined when none. */
  read(busyTimeoutMs: number): SavedStatus | undefined {
    const loaded = this.cache.load(parseDocument, busyTimeoutMs)
    if (loaded.kind === 'unavailable') {
      this.disabled = true
      throw loaded.error
    }
    this.savedRows = loaded.rows
    if (loaded.kind === 'import') {
      this.legacyReceipt = loaded.receipt
      return { document: loaded.value.document, source: 'legacy' }
    }
    return this.readRows()
  }

  /** The saved rows from the last read, for when hydration rejects a legacy file. */
  readRows(): SavedStatus | undefined {
    return this.savedRows.length > 0
      ? { document: assemble(this.savedRows), source: 'rows' }
      : undefined
  }

  /** Hydration admitted the legacy file; the next commit records it imported and removes it. */
  confirmLegacyImport(): void {
    this.pendingImport = this.legacyReceipt
  }

  /** Hydration rejected the legacy file: remove it and keep the rows. */
  rejectLegacy(): void {
    if (this.legacyReceipt !== undefined) {
      this.cache.discardLegacy(this.legacyReceipt)
      this.legacyReceipt = undefined
    }
  }

  /** Writes changed rows in one transaction; throws on lock or I/O failure for a later retry. */
  write(file: LastStatusFile, busyTimeoutMs: number): boolean {
    if (this.disabled) {
      return false
    }
    this.cache.write(rowsOf(file), { importReceipt: this.pendingImport, busyTimeoutMs })
    this.pendingImport = undefined
    this.legacyReceipt = undefined
    return true
  }

  close(): void {
    this.cache.close()
    this.savedRows = []
    this.legacyReceipt = undefined
    this.pendingImport = undefined
    this.disabled = false
  }
}

function parseDocument(text: string): { document: unknown } | null {
  try {
    return { document: JSON.parse(text) }
  } catch {
    console.warn('[agent-hooks] last-status file is not valid JSON; ignoring')
    return null
  }
}
