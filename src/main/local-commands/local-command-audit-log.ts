import { createHash } from 'node:crypto'
import { appendFile, chmod, readFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LocalCommandAuditEntry } from '../../shared/local-commands/local-command-desktop-types'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_READ = 500
const KEPT_FILES = 3
/** Long commands keep their start plus a hash, so a few big entries can't flush the history. */
const MAX_COMMAND_CHARS = 1000

function isAuditEntry(value: unknown): value is LocalCommandAuditEntry {
  if (value === null || typeof value !== 'object') {
    return false
  }
  return (
    'at' in value &&
    typeof value.at === 'number' &&
    'command' in value &&
    typeof value.command === 'string' &&
    'outcome' in value &&
    typeof value.outcome === 'string'
  )
}

/**
 * Append-only record of every request this computer saw and what happened to it: the command,
 * folder, decision and exit status. Never the output (it can hold anything the command printed).
 * Rotates at 2 MB and keeps the two previous files (.1, .2). Writes run one at a time.
 */
export class LocalCommandAuditLog {
  private readonly path: string
  private chain: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'local-commands-audit.jsonl')
  }

  append(entry: LocalCommandAuditEntry): Promise<void> {
    const long = entry.command.length > MAX_COMMAND_CHARS
    const stored: LocalCommandAuditEntry = long
      ? {
          ...entry,
          command: entry.command.slice(0, MAX_COMMAND_CHARS),
          commandLength: entry.command.length,
          commandSha256: createHash('sha256').update(entry.command).digest('hex')
        }
      : entry
    this.chain = this.chain
      .then(async () => {
        await this.rotateIfFull()
        await appendFile(this.path, `${JSON.stringify(stored)}\n`, {
          encoding: 'utf8',
          mode: 0o600
        })
      })
      .catch((error: unknown) => {
        // The command already ran or was refused; a full disk must not fail the request.
        console.warn('[local-commands] Could not write the audit log', error)
      })
    return this.chain
  }

  /** Newest first, after any pending writes. */
  async recent(limit: number): Promise<LocalCommandAuditEntry[]> {
    await this.chain
    const wanted = Math.max(1, Math.min(limit, MAX_READ))
    const entries: LocalCommandAuditEntry[] = []
    const files = [
      this.path,
      ...Array.from({ length: KEPT_FILES - 1 }, (_, i) => `${this.path}.${i + 1}`)
    ]
    for (const file of files) {
      const text = await readFile(file, 'utf8').catch(() => null)
      if (text === null) {
        continue
      }
      const lines = text.split('\n').filter(Boolean)
      for (let index = lines.length - 1; index >= 0 && entries.length < wanted; index -= 1) {
        try {
          const parsed: unknown = JSON.parse(lines[index]!)
          if (isAuditEntry(parsed)) {
            entries.push(parsed)
          }
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

  private async rotateIfFull(): Promise<void> {
    const size = await stat(this.path).then(
      (info) => info.size,
      () => 0
    )
    if (size < MAX_BYTES) {
      return
    }
    for (let index = KEPT_FILES - 1; index >= 1; index -= 1) {
      const from = index === 1 ? this.path : `${this.path}.${index - 1}`
      await rename(from, `${this.path}.${index}`)
        .then(() => chmod(`${this.path}.${index}`, 0o600))
        .catch(() => {
          // A gap in the rotation (first rotations) is fine.
        })
    }
  }
}
