import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Copies that hold bytes ~/.codex lacks; re-read only once either file changes. */
export const KEPT_COPIES_FILE = '.orca-history-copies-kept.json'

export type KeptCopies = Record<string, string>

/**
 * `settled`: the Orca version whose run found nothing left to delete or retry in this home, so
 * later runs of that version skip it; a new version looks once more.
 */
export type KeptCopiesRecord = {
  differs: KeptCopies
  settled: string | null
  /** Bytes a comparison matched before its launch ran out, while the pair keeps `key`. */
  progress?: CompareProgress
}

export type CompareProgress = Record<string, { key: string; matched: number }>

function readProgress(value: unknown): CompareProgress {
  if (!value || typeof value !== 'object') {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, { key: string; matched: number }] => {
      const item: unknown = entry[1]
      return (
        typeof item === 'object' &&
        item !== null &&
        'key' in item &&
        'matched' in item &&
        typeof item.key === 'string' &&
        Number.isSafeInteger(item.matched)
      )
    })
  )
}

export function readKeptCopies(accountHome: string): KeptCopiesRecord {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(accountHome, KEPT_COPIES_FILE), 'utf8'))
    if (parsed && typeof parsed === 'object' && 'differs' in parsed) {
      const differs = parsed.differs
      const settled =
        'settled' in parsed && typeof parsed.settled === 'string' ? parsed.settled : null
      if (differs && typeof differs === 'object') {
        return {
          differs: Object.fromEntries(
            Object.entries(differs).filter((entry): entry is [string, string] => {
              return typeof entry[1] === 'string'
            })
          ),
          settled,
          progress: readProgress('progress' in parsed ? parsed.progress : null)
        }
      }
    }
  } catch {
    // Missing or torn: those copies are compared again.
  }
  return { differs: {}, settled: null }
}

// Only ever skips work: a stale entry keeps a copy, never deletes one.
export function writeKeptCopies(
  accountHome: string,
  { differs, settled, progress = {} }: KeptCopiesRecord
): void {
  const target = join(accountHome, KEPT_COPIES_FILE)
  const staged = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(staged, `${JSON.stringify({ version: 1, differs, settled, progress })}\n`)
    renameSync(staged, target)
  } catch {
    try {
      unlinkSync(staged)
    } catch {
      // Nothing staged.
    }
  }
}
