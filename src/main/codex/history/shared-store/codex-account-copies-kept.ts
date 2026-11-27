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
  /** Copies whose comparison passed with both files at `key`, not yet moved (open, busy). */
  verified?: KeptCopies
  /** The last retried copy (and trashed copy) a launch offered: the next launch starts after it. */
  retryAfter?: string
  trashRetryAfter?: string
}

/**
 * Up to `slots` of `items`, in name order, starting just after `after` and wrapping, so a lasting
 * keep at the front can't hold back the rest; `next` is where the following launch starts.
 */
export function takeInTurn<T>(
  items: T[],
  nameOf: (item: T) => string,
  after: string | undefined,
  slots: number
): { taken: T[]; next: string | undefined } {
  const sorted = items
    .map((item) => ({ item, name: nameOf(item) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (slots >= sorted.length) {
    return { taken: sorted.map((entry) => entry.item), next: undefined }
  }
  if (slots <= 0) {
    return { taken: [], next: after }
  }
  const found = after === undefined ? -1 : sorted.findIndex((entry) => entry.name > after)
  const start = Math.max(0, found)
  const turn = [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, slots)
  return { taken: turn.map((entry) => entry.item), next: turn.at(-1)?.name }
}

export type CompareProgress = Record<string, { key: string; matched: number }>

function readKeys(value: unknown): KeptCopies {
  if (!value || typeof value !== 'object') {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

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
          differs: readKeys(differs),
          settled,
          progress: readProgress('progress' in parsed ? parsed.progress : null),
          verified: readKeys('verified' in parsed ? parsed.verified : null),
          retryAfter:
            'retryAfter' in parsed && typeof parsed.retryAfter === 'string'
              ? parsed.retryAfter
              : undefined,
          trashRetryAfter:
            'trashRetryAfter' in parsed && typeof parsed.trashRetryAfter === 'string'
              ? parsed.trashRetryAfter
              : undefined
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
  { differs, settled, progress = {}, verified = {}, retryAfter, trashRetryAfter }: KeptCopiesRecord
): void {
  const target = join(accountHome, KEPT_COPIES_FILE)
  const staged = `${target}.${process.pid}.tmp`
  const text = `${JSON.stringify({
    version: 1,
    differs,
    settled,
    progress,
    verified,
    retryAfter,
    trashRetryAfter
  })}\n`
  try {
    // A launch that learned nothing new leaves the file alone.
    if (readFileSync(target, 'utf8') === text) {
      return
    }
  } catch {
    // Missing: written below.
  }
  try {
    writeFileSync(staged, text)
    renameSync(staged, target)
  } catch {
    try {
      unlinkSync(staged)
    } catch {
      // Nothing staged.
    }
  }
}
