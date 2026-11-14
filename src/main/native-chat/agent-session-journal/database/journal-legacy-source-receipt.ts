import { statSync, type BigIntStats } from 'node:fs'
import { stat } from 'node:fs/promises'

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
      wal: { kind: 'empty' } | { kind: 'nonempty'; size: string }
    }
  | { disposition: 'no-source-at-initialization' | 'uncertifiable' }
)

export function journalLegacyFileIdentity(filename: string): JournalLegacyFileIdentity {
  return journalLegacyFileIdentityFromStat(
    statSync(filename, { bigint: true, throwIfNoEntry: false })
  )
}

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

export async function readJournalLegacySourceReceipt(
  filename: string
): Promise<JournalLegacySourceReceipt> {
  try {
    const [main, wal] = await Promise.all([
      statIfPresent(filename),
      statIfPresent(`${filename}-wal`)
    ])
    return sourceReceipt(main ? journalLegacyFileIdentityFromStat(main) : undefined, wal)
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
    wal: wal && wal.size > 0n ? { kind: 'nonempty', size: String(wal.size) } : { kind: 'empty' }
  }
}
