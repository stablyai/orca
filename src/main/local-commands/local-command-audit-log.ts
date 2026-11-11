import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LocalCommandAuditEntry } from '../../shared/local-commands/local-command-desktop-types'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_READ = 500
const KEPT_FILES = 3
/** Long commands keep their start plus a hash, so a few big entries can't flush the history. */
const MAX_COMMAND_CHARS = 1000

/**
 * Append-only record of every request this computer saw and what happened to it: the command,
 * folder, decision and exit status. Never the output (it can hold anything the command printed).
 * Rotates at 2 MB and keeps the two previous files (.1, .2).
 */
export class LocalCommandAuditLog {
  private readonly path: string

  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'local-commands-audit.jsonl')
  }

  append(entry: LocalCommandAuditEntry): void {
    try {
      this.rotateIfFull()
      const long = entry.command.length > MAX_COMMAND_CHARS
      const stored: LocalCommandAuditEntry = long
        ? {
            ...entry,
            command: entry.command.slice(0, MAX_COMMAND_CHARS),
            commandLength: entry.command.length,
            commandSha256: createHash('sha256').update(entry.command).digest('hex')
          }
        : entry
      appendFileSync(this.path, `${JSON.stringify(stored)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      // The command itself already ran or was refused; a full disk must not crash the request.
      console.warn('[local-commands] Could not write the audit log', error)
    }
  }

  /** Newest first. */
  recent(limit: number): LocalCommandAuditEntry[] {
    const wanted = Math.max(1, Math.min(limit, MAX_READ))
    const entries: LocalCommandAuditEntry[] = []
    const files = [
      this.path,
      ...Array.from({ length: KEPT_FILES - 1 }, (_, i) => `${this.path}.${i + 1}`)
    ]
    for (const file of files) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n').filter(Boolean)
      for (let index = lines.length - 1; index >= 0 && entries.length < wanted; index -= 1) {
        try {
          entries.push(JSON.parse(lines[index]!) as LocalCommandAuditEntry)
        } catch {
          // A torn last line from a crash is skipped, not fatal.
        }
      }
      if (entries.length >= wanted) {
        break
      }
    }
    return entries
  }

  private rotateIfFull(): void {
    let size = 0
    try {
      size = statSync(this.path).size
    } catch {
      return
    }
    if (size < MAX_BYTES) {
      return
    }
    for (let index = KEPT_FILES - 1; index >= 1; index -= 1) {
      const from = index === 1 ? this.path : `${this.path}.${index - 1}`
      try {
        renameSync(from, `${this.path}.${index}`)
        chmodSync(`${this.path}.${index}`, 0o600)
      } catch {
        // A gap in the rotation (first rotations) is fine.
      }
    }
  }
}
