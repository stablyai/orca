import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import type { SessionSearchFileIdentity } from '../storage/session-search-file-cursor'
import type { SessionSearchSnapshotRow } from './session-search-worker-protocol'

export abstract class SessionSearchCursorSnapshot {
  protected readonly committed = new Map<string, SessionSearchSnapshotRow>()
  protected readonly speculative = new Map<string, SessionSearchSnapshotRow>()
  abstract get acceptingReads(): boolean
  files() {
    return [...this.committed.values()]
  }
  /** The stat of a file indexed through its end; quiet files can reuse it instead of a restat. */
  committedStat(path: string): SessionSearchSnapshotRow | undefined {
    const row = this.committed.get(path)
    // A file that grew during its read commits an offset past its recorded size; restat it.
    return row?.state === 'current' && row.sizeBytes !== null && row.byteOffset === row.sizeBytes
      ? row
      : undefined
  }
  protected row(path: string, identity: SessionSearchFileIdentity, speculative = true) {
    if (!this.acceptingReads) {
      return null
    }
    const row = (speculative && this.speculative.get(path)) || this.committed.get(path)
    return row &&
      (!identity ||
        !row.identity ||
        (identity.dev === row.identity.dev && identity.ino === row.identity.ino))
      ? row
      : null
  }
  indexedFile(path: string, identity: SessionSearchFileIdentity) {
    const row = this.row(path, identity)
    return row
      ? { byteOffset: row.byteOffset, sizeBytes: row.sizeBytes, mtimeMs: row.mtimeMs }
      : null
  }
  coversTranscript(candidate: SessionFileCandidate): boolean {
    const { file } = candidate
    const row = this.committed.get(file.path)
    return (
      this.acceptingReads &&
      !!row &&
      row.state === 'current' &&
      row.mtimeMs === file.mtimeMs &&
      typeof file.sizeBytes === 'number' &&
      row.sizeBytes === file.sizeBytes &&
      row.byteOffset === file.sizeBytes &&
      (typeof file.dev !== 'number' ||
        typeof file.ino !== 'number' ||
        (row.identity?.dev === file.dev && row.identity.ino === file.ino))
    )
  }
  resumableCursor(candidate: SessionFileCandidate) {
    const { file } = candidate
    const row = this.row(
      file.path,
      typeof file.dev === 'number' && typeof file.ino === 'number'
        ? { dev: file.dev, ino: file.ino }
        : null
    )
    return row &&
      row.state === 'current' &&
      row.prefixHash &&
      row.byteOffset !== null &&
      row.byteOffset > 0 &&
      typeof file.sizeBytes === 'number' &&
      row.byteOffset <= file.sizeBytes
      ? { byteOffset: row.byteOffset, prefixHash: row.prefixHash }
      : null
  }
}
