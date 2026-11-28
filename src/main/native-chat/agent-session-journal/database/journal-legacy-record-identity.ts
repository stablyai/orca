import { lstatSync, statSync, type BigIntStats } from 'node:fs'
import { JournalDamageError } from '../replay/journal-open-failure'
import { journalDatabasePath } from './journal-host-database'
import { journalLegacyRecordPaths } from './journal-legacy-record-paths'

export type RecordFile = { path: string; identity: string | null }

export function recordFileIdentity(stats: BigIntStats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':')
}

function captureFile(path: string, ignoreEmpty = false): RecordFile {
  // A dangling link is present and cannot certify absence.
  const stats = lstatSync(path, { throwIfNoEntry: false })
    ? statSync(path, { bigint: true })
    : undefined
  return {
    path,
    identity:
      stats && !(ignoreEmpty && stats.isFile() && stats.size === 0n)
        ? recordFileIdentity(stats)
        : null
  }
}

export function captureJournalLegacyRecordFiles(
  stateDirectory: string
): readonly [RecordFile, RecordFile] {
  const [primary, backup] = journalLegacyRecordPaths(stateDirectory)
  return [captureFile(primary), captureFile(backup)]
}

export function captureJournalLegacyRecordSource(stateDirectory: string): readonly RecordFile[] {
  const source = journalDatabasePath(stateDirectory)
  // SQLite read-only opens may create an empty WAL without changing the source generation.
  return [captureFile(source), captureFile(`${source}-wal`, true)]
}

export function assertJournalLegacyRecordFilesStable(files: readonly RecordFile[]): void {
  for (const { path, identity } of files) {
    if (captureFile(path).identity !== identity) {
      throw changedRecordFile()
    }
  }
}

export function changedRecordFile(): Error {
  return new Error('the original chat records changed during initialization')
}

export function journalLegacyRecordFingerprint(files: readonly RecordFile[]): string {
  return JSON.stringify(files.map(({ identity }) => identity))
}

export class JournalLegacyRecordCorruptionError extends JournalDamageError {
  constructor(readonly fingerprint: string) {
    super('the original chat records and their backup could not be read')
  }
}
