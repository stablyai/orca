import { appendFileSync, chmodSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LocalCommandAuditEntry } from '../../shared/local-commands/local-command-desktop-types'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_READ = 500

/**
 * Append-only record of every request this computer saw and what happened to it: the command,
 * folder, decision and exit status. Never the output (it can hold anything the command printed).
 * One rotation keeps the previous file as .1.
 */
export class LocalCommandAuditLog {
  private readonly path: string

  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'local-commands-audit.jsonl')
  }

  append(entry: LocalCommandAuditEntry): void {
    try {
      this.rotateIfFull()
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      // The command itself already ran or was refused; a full disk must not crash the request.
      console.warn('[local-commands] Could not write the audit log', error)
    }
  }

  /** Newest first. */
  recent(limit: number): LocalCommandAuditEntry[] {
    const wanted = Math.max(1, Math.min(limit, MAX_READ))
    const entries: LocalCommandAuditEntry[] = []
    for (const file of [this.path, `${this.path}.1`]) {
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
    if (size >= MAX_BYTES) {
      renameSync(this.path, `${this.path}.1`)
      chmodSync(`${this.path}.1`, 0o600)
    }
  }
}
