import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Copies that hold bytes ~/.codex lacks; re-read only once either file changes. */
export const KEPT_COPIES_FILE = '.orca-history-copies-kept.json'

export type KeptCopies = Record<string, string>

export function readKeptCopies(accountHome: string): KeptCopies {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(accountHome, KEPT_COPIES_FILE), 'utf8'))
    if (parsed && typeof parsed === 'object' && 'differs' in parsed) {
      const differs = parsed.differs
      if (differs && typeof differs === 'object') {
        return Object.fromEntries(
          Object.entries(differs).filter((entry): entry is [string, string] => {
            return typeof entry[1] === 'string'
          })
        )
      }
    }
  } catch {
    // Missing or torn: those copies are compared again.
  }
  return {}
}

// Only ever skips work: a stale entry keeps a copy, never deletes one.
export function writeKeptCopies(accountHome: string, differs: KeptCopies): void {
  const target = join(accountHome, KEPT_COPIES_FILE)
  const staged = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(staged, `${JSON.stringify({ version: 1, differs })}\n`)
    renameSync(staged, target)
  } catch {
    try {
      unlinkSync(staged)
    } catch {
      // Nothing staged.
    }
  }
}
