import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'

/**
 * The JSON file older builds read and write. This build only imports it: the file is removed
 * once rows holding its admitted contents have committed, and only if it still has the bytes
 * that were imported, so a file another build rewrote meanwhile survives for the next start.
 */
export class LegacyLastStatusFile {
  private readHash: string | undefined
  private removableHash: string | undefined
  /** Whether the removable bytes were imported (recorded in history) or merely rejected. */
  private removableImported = false

  constructor(readonly path: string) {}

  /** Parsed contents and their hash, or undefined when absent or unreadable. */
  read(): { document: unknown; hash: string } | undefined {
    const raw = this.readRaw()
    if (raw === undefined) {
      return undefined
    }
    const hash = hashContent(raw)
    try {
      const document: unknown = JSON.parse(raw)
      this.readHash = hash
      return { document, hash }
    } catch {
      console.warn('[agent-hooks] last-status file is not valid JSON; ignoring')
      // Unreadable either way; dropping it keeps it from shadowing the rows on every start.
      this.removableHash = hash
      this.removableImported = false
      return undefined
    }
  }

  /** Hydration admitted the contents read last; they may go once rows hold them. */
  confirmRead(): void {
    if (this.readHash !== undefined) {
      this.markImported(this.readHash)
    }
  }

  /** Hydration rejected the contents read last: remove them, without recording an import. */
  discardRead(): void {
    if (this.readHash !== undefined) {
      this.removableHash = this.readHash
      this.removableImported = false
    }
  }

  /** Contents imported now, or earlier when the file could not be removed. */
  markImported(hash: string): void {
    this.removableHash = hash
    this.removableImported = true
  }

  /** Hash to record as imported with the rows that hold it. */
  get pendingImportHash(): string | undefined {
    return this.removableImported ? this.removableHash : undefined
  }

  /** Call only after the rows holding the imported contents have committed. */
  removeIfUnchanged(): void {
    const expected = this.removableHash
    if (expected === undefined) {
      return
    }
    const raw = this.readRaw()
    if (raw !== undefined && hashContent(raw) !== expected) {
      // Rewritten by another build since import: the next start imports it instead.
      this.removableHash = undefined
      return
    }
    try {
      if (raw !== undefined) {
        rmSync(this.path, { force: true })
      }
      this.removableHash = undefined
    } catch (err) {
      console.warn('[agent-hooks] failed to remove migrated last-status file:', err)
    }
  }

  reset(): void {
    this.readHash = undefined
    this.removableHash = undefined
    this.removableImported = false
  }

  private readRaw(): string | undefined {
    try {
      return readFileSync(this.path, 'utf8')
    } catch (err) {
      // Why: missing file is normal (migrated or first launch); other errors degrade to the rows.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[agent-hooks] failed to read last-status file:', err)
      }
      return undefined
    }
  }
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('base64')
}
