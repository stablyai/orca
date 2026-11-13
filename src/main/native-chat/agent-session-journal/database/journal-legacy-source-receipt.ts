import { statSync } from 'node:fs'

export const JOURNAL_LEGACY_SOURCE_RECEIPT = 'journal.legacy-source-copy.v1'

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
  const file = statSync(filename, { bigint: true, throwIfNoEntry: false })
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
  const version = { version: 1, profileCopyInventoryVersion: 1 } as const
  try {
    if (!statSync(filename, { bigint: true, throwIfNoEntry: false })) {
      return { ...version, disposition: 'no-source-at-initialization' }
    }
    const main = journalLegacyFileIdentity(filename)
    const wal = statSync(`${filename}-wal`, { bigint: true, throwIfNoEntry: false })
    if (wal && !wal.isFile()) {
      return { ...version, disposition: 'uncertifiable' }
    }
    return {
      ...version,
      disposition: 'copied-source',
      main,
      wal: wal && wal.size > 0n ? { kind: 'nonempty', size: String(wal.size) } : { kind: 'empty' }
    }
  } catch {
    return { ...version, disposition: 'uncertifiable' }
  }
}
