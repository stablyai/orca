import { statSync, type BigIntStats } from 'node:fs'

export const JOURNAL_LEGACY_SOURCE_RECEIPT = 'journal.legacy-source-copy.v1'
const VERSION = { version: 1, profileCopyInventoryVersion: 1 } as const

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

function journalLegacyFileIdentity(filename: string): JournalLegacyFileIdentity {
  return journalLegacyFileIdentityFromStat(
    statSync(filename, { bigint: true, throwIfNoEntry: false })
  )
}

function journalLegacyFileIdentityFromStat(
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

/** Path stats avoid releasing another connection's process-wide SQLite locks on close. */
export function captureJournalLegacySourceReceipt(filename: string): JournalLegacySourceReceipt {
  try {
    const main = statSync(filename, { bigint: true, throwIfNoEntry: false })
    if (!main) {
      return sourceReceipt(main)
    }
    return sourceReceipt(
      journalLegacyFileIdentity(filename),
      statSync(`${filename}-wal`, { bigint: true, throwIfNoEntry: false })
    )
  } catch {
    return { ...VERSION, disposition: 'uncertifiable' }
  }
}

function sourceReceipt(
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
 * Whether the original is provably still as a saved receipt recorded it, compared by meaning: a
 * newer receipt shape is never a write. A receipt saved before WAL identity was kept records a
 * nonempty WAL by its size alone, and reused WAL frames can keep that size, so it proves nothing.
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
  return sameJson(withoutDevice(storedFile), withoutDevice(file)) && sameJson(storedWal, wal)
}

/** A device number is reassigned at reboot or remount; the inode and times still name the file. */
function withoutDevice(file: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(file.main)) {
    return file
  }
  const { dev: _dev, ...main } = file.main
  return { ...file, main }
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

/** When a saved receipt last saw the original written, in ms; null when it can't say. */
export function journalLegacySourceLastRead(saved: string | undefined): number | null {
  try {
    const stored: unknown = saved === undefined ? undefined : JSON.parse(saved)
    if (!isRecord(stored) || !isRecord(stored.main) || typeof stored.main.mtimeNs !== 'string') {
      return null
    }
    const wal =
      isRecord(stored.wal) && typeof stored.wal.mtimeNs === 'string' ? stored.wal.mtimeNs : '0'
    const latest = [BigInt(stored.main.mtimeNs), BigInt(wal)].reduce((a, b) => (a > b ? a : b))
    return Number(latest / 1_000_000n)
  } catch {
    return null
  }
}
