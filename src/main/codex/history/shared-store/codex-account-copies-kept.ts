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
}

/** Where each phase's next launch starts, so a launch cut short can't hold back the rest. */
const CURSOR_FILE = '.orca-history-copies-cursor.json'
const CURSOR_FIELDS = ['walkAfter', 'retryAfter', 'trashWalkAfter', 'trashRetryAfter'] as const
export type CopiesCursor = Partial<Record<(typeof CURSOR_FIELDS)[number], string>>

export function readCursor(accountHome: string): CopiesCursor {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(accountHome, CURSOR_FILE), 'utf8'))
    const fields: Record<string, unknown> =
      parsed && typeof parsed === 'object' ? { ...parsed } : {}
    return Object.fromEntries(
      CURSOR_FIELDS.flatMap((field) =>
        typeof fields[field] === 'string' ? [[field, fields[field]]] : []
      )
    )
  } catch {
    return {}
  }
}

/** Its own small file, so moving a cursor never rewrites the kept-copies record. */
export function writeCursor(accountHome: string, cursor: CopiesCursor): void {
  // Keys in one order, so the same cursor read back and saved is the same text.
  const text = `${JSON.stringify(cursor, Object.keys(cursor).sort())}\n`
  writeIfChanged(join(accountHome, CURSOR_FILE), text, text === '{}\n')
}

/** `items` in name order, starting just after `after` and wrapping. */
export function inTurnOrder<T>(items: T[], nameOf: (item: T) => string, after?: string): T[] {
  const sorted = items
    .map((item) => ({ item, name: nameOf(item) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const found = after === undefined ? -1 : sorted.findIndex((entry) => entry.name > after)
  const start = Math.max(0, found)
  return [...sorted.slice(start), ...sorted.slice(0, start)].map((entry) => entry.item)
}

/**
 * Up to `slots` of `items` in turn after `after`, so a lasting keep at the front can't hold back
 * the rest; `next` is where the following launch starts.
 */
export function takeInTurn<T>(
  items: T[],
  nameOf: (item: T) => string,
  after: string | undefined,
  slots: number
): { taken: T[]; next: string | undefined } {
  if (slots <= 0) {
    return { taken: [], next: after }
  }
  if (slots >= items.length) {
    return { taken: items, next: undefined }
  }
  const turn = inTurnOrder(items, nameOf, after).slice(0, slots)
  const last = turn.at(-1)
  return { taken: turn, next: last === undefined ? undefined : nameOf(last) }
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
          verified: readKeys('verified' in parsed ? parsed.verified : null)
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
  { differs, settled, progress = {}, verified = {} }: KeptCopiesRecord,
  /** The record as read this launch: when nothing differs from it, nothing is serialized. */
  previous?: KeptCopiesRecord
): void {
  if (previous && sameRecord(previous, { differs, settled, progress, verified })) {
    return
  }
  // Keys sorted: the same record always serializes the same, whatever order a walk visited it in.
  const text = `${JSON.stringify({
    version: 1,
    differs: sortedKeys(differs),
    settled,
    progress: sortedKeys(progress),
    verified: sortedKeys(verified)
  })}\n`
  writeIfChanged(join(accountHome, KEPT_COPIES_FILE), text, false)
}

function sameKeys<T>(
  a: Record<string, T>,
  b: Record<string, T>,
  same: (x: T, y: T) => boolean
): boolean {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
  )
}

// Compared entry by entry, without sorting or serializing anything.
function sameRecord(a: KeptCopiesRecord, b: KeptCopiesRecord): boolean {
  const equal = (x: string, y: string): boolean => x === y
  return (
    a.settled === b.settled &&
    sameKeys(a.differs, b.differs, equal) &&
    sameKeys(a.verified ?? {}, b.verified ?? {}, equal) &&
    sameKeys(
      a.progress ?? {},
      b.progress ?? {},
      (x, y) => x.key === y.key && x.matched === y.matched
    )
  )
}

const sortedKeys = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

// A launch that learned nothing new leaves the file alone; `empty` text means no file at all.
function writeIfChanged(target: string, text: string, empty: boolean): void {
  let current: string | null = null
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    // Missing.
  }
  if (current === text || (empty && current === null)) {
    return
  }
  const staged = `${target}.${process.pid}.tmp`
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
