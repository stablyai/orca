import type { BigIntStats } from 'node:fs'
import { stat } from 'node:fs/promises'

export const JOURNAL_LEGACY_SOURCE_RECEIPT = 'journal.legacy-source-copy.v1'
/** The original found damaged, the check that judged it, and why; read again once either changes. */
export const JOURNAL_LEGACY_SOURCE_DAMAGED = 'journal.legacy-source-damaged.v1'
/** Set after a pass absorbed every original chat, so each chat here carries its revision. */
export const JOURNAL_LEGACY_REVISIONS_KEPT = 'journal.legacy-revisions-kept.v1'
export const JOURNAL_LEGACY_SOURCE_RECEIPT_VERSION = {
  version: 1,
  profileCopyInventoryVersion: 1
} as const
const VERSION = JOURNAL_LEGACY_SOURCE_RECEIPT_VERSION

export type JournalLegacyFileIdentity = {
  dev: string
  ino: string
  size: string
  mtimeNs: string
  ctimeNs: string
}

export type JournalLegacySourceReceipt = {
  version: 1
  profileCopyInventoryVersion: 1
} & (
  | {
      disposition: 'copied-source'
      main: JournalLegacyFileIdentity
      wal: { kind: 'empty' } | { kind: 'nonempty'; size: string; ino?: string; mtimeNs?: string }
    }
  | { disposition: 'no-source-at-initialization' | 'uncertifiable' }
)

export function journalLegacyFileIdentityFromStat(
  file: BigIntStats | undefined
): JournalLegacyFileIdentity {
  if (!file?.isFile() || file.ino === 0n || file.nlink !== 1n) {
    throw new Error('legacy journal identity is unavailable')
  }
  return {
    dev: String(file.dev),
    ino: String(file.ino),
    size: String(file.size),
    mtimeNs: String(file.mtimeNs),
    ctimeNs: String(file.ctimeNs)
  }
}

export async function readJournalLegacySourceReceipt(
  filename: string
): Promise<JournalLegacySourceReceipt> {
  try {
    const [main, wal] = await Promise.all([
      statIfPresent(filename),
      statIfPresent(`${filename}-wal`)
    ])
    return journalLegacySourceReceiptOf(
      main ? journalLegacyFileIdentityFromStat(main) : undefined,
      wal
    )
  } catch {
    return { ...VERSION, disposition: 'uncertifiable' }
  }
}

async function statIfPresent(filename: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(filename, { bigint: true })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

export function journalLegacySourceReceiptOf(
  main?: JournalLegacyFileIdentity,
  wal?: BigIntStats
): JournalLegacySourceReceipt {
  if (!main) {
    return { ...VERSION, disposition: 'no-source-at-initialization' }
  }
  if (wal && !wal.isFile()) {
    return { ...VERSION, disposition: 'uncertifiable' }
  }
  return {
    ...VERSION,
    disposition: 'copied-source',
    main,
    // Reused WAL frames can keep the size, so the file's own identity tells a new write apart.
    wal:
      wal && wal.size > 0n
        ? {
            kind: 'nonempty',
            size: String(wal.size),
            ino: String(wal.ino),
            mtimeNs: String(wal.mtimeNs)
          }
        : { kind: 'empty' }
  }
}

/**
 * Whether the original is still as a saved receipt recorded it, compared by meaning. A receipt
 * saved before WAL identity was kept records a nonempty WAL by its size alone, so the fields
 * added since are compared only when it has them: a newer receipt shape is never a write.
 */
export function sameJournalLegacySource(
  saved: string | undefined,
  current: JournalLegacySourceReceipt
): boolean {
  if (saved === undefined || current.disposition !== 'copied-source') {
    return false
  }
  let stored: unknown
  try {
    stored = JSON.parse(saved)
  } catch {
    return false
  }
  if (!isRecord(stored) || !isRecord(stored.wal)) {
    return false
  }
  const { wal, ...file } = current
  const { wal: storedWal, ...storedFile } = stored
  const walFields =
    wal.kind === 'nonempty' && !('ino' in storedWal) ? { kind: wal.kind, size: wal.size } : wal
  return sameJson(storedFile, file) && sameJson(storedWal, walFields)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameJson(saved: unknown, current: unknown): boolean {
  if (!isRecord(saved) || !isRecord(current)) {
    return saved === current
  }
  const keys = Object.keys(current)
  return (
    Object.keys(saved).length === keys.length &&
    keys.every((key) => key in saved && sameJson(saved[key], current[key]))
  )
}

/** A damage record's receipt; with `check`, only when that check judged it. */
export function journalLegacyDamagedReceipt(
  value: string | undefined,
  check?: string
): string | undefined {
  if (value === undefined) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) &&
      'receipt' in parsed &&
      'check' in parsed &&
      (check === undefined || parsed.check === check)
      ? JSON.stringify(parsed.receipt)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether opening a store without chats would take nothing in from the original: it is as last
 * absorbed or recorded damaged, or has no identity to tell a change by. The open PR watches make
 * once serving still reconciles it; this only decides whether launch waits on that.
 */
export function journalLegacySourceSettled(
  meta: (key: string) => string | undefined,
  current: JournalLegacySourceReceipt
): boolean {
  return (
    current.disposition !== 'copied-source' ||
    (meta(JOURNAL_LEGACY_REVISIONS_KEPT) !== undefined &&
      sameJournalLegacySource(meta(JOURNAL_LEGACY_SOURCE_RECEIPT), current)) ||
    sameJournalLegacySource(
      journalLegacyDamagedReceipt(meta(JOURNAL_LEGACY_SOURCE_DAMAGED)),
      current
    )
  )
}
