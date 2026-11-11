import type { SessionSearchReadContext } from './session-search-work-queue'
import type { SessionSearchStore } from './storage/session-search-store'
import {
  bindSessionSearchReadSettlement,
  invalidateSessionSearchAcceptedContent,
  settleSessionSearchContent
} from './session-search-content-settlement'
import { initializeSessionSearchStorage } from './session-search-storage-bootstrap'
import type { SessionSearchCatalogCandidates } from './session-search-catalog-candidates'
import type {
  SessionSearchIndexWriter,
  SessionSearchFileWrite
} from './storage/session-search-index-writer'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { TranscriptSessionIdentity } from '../ai-vault/transcripts/session-transcript-consumers'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchFileRow } from './storage/session-search-store-types'

function identity(row: SessionSearchFileRow | undefined, failedCommit = false): string {
  return JSON.stringify(
    row && [
      row.mtimeMs,
      row.sizeBytes,
      row.byteOffset,
      row.prefixHash,
      row.identity,
      row.failCount + Number(failedCommit)
    ]
  )
}
const initialized = new WeakSet<SyncDatabase>()
function ensureFailures(db: SyncDatabase): void {
  initializeSessionSearchStorage(db)
  if (initialized.has(db)) {
    return
  }
  db.exec(
    'CREATE TEMP TABLE IF NOT EXISTS search_metadata_write_failures(path TEXT PRIMARY KEY, identity TEXT NOT NULL) WITHOUT ROWID'
  )
  db.exec(
    'CREATE TEMP TRIGGER search_metadata_failure_delete AFTER DELETE ON main.files BEGIN DELETE FROM search_metadata_write_failures WHERE path=OLD.path; END'
  )
  initialized.add(db)
}

export function wakeSessionSearchMetadataWrite(
  db: SyncDatabase,
  path: string,
  row: SessionSearchFileRow | undefined
): boolean {
  ensureFailures(db)
  const failed = db
    .prepare('SELECT identity FROM temp.search_metadata_write_failures WHERE path=?')
    .get(path)
  if (!failed) {
    return false
  }
  db.prepare('DELETE FROM temp.search_metadata_write_failures WHERE path=?').run(path)
  return row?.state === 'failed' && failed.identity === identity(row)
}

export function trackSessionSearchMetadataWrite(
  db: SyncDatabase,
  path: string,
  row: () => SessionSearchFileRow | undefined,
  write: SessionSearchFileWrite,
  metadataOnly: boolean
): SessionSearchFileWrite {
  ensureFailures(db)
  const previous = row()
  const metadataFailure = db
    .prepare('SELECT identity FROM temp.search_metadata_write_failures WHERE path=?')
    .get(path)
  const eligible = previous?.state === 'current' || metadataFailure?.identity === identity(previous)
  if (!metadataOnly) {
    db.prepare('DELETE FROM temp.search_metadata_write_failures WHERE path=?').run(path)
  }
  return {
    ...write,
    commit: (outcome) => {
      let accepted = false
      try {
        accepted = write.commit(outcome)
        return accepted
      } finally {
        if (metadataOnly && !accepted && eligible) {
          db.prepare(
            'INSERT OR REPLACE INTO temp.search_metadata_write_failures(path,identity) VALUES(?,?)'
          ).run(path, identity(row(), true))
        } else {
          db.prepare('DELETE FROM temp.search_metadata_write_failures WHERE path=?').run(path)
        }
      }
    }
  }
}

export function admitSessionSearchStoreWrite(
  db: SyncDatabase,
  writer: SessionSearchIndexWriter,
  candidates: SessionSearchCatalogCandidates | undefined,
  candidate: SessionFileCandidate,
  mode: 'replace' | 'append',
  previousByteOffset: number,
  identity: (() => TranscriptSessionIdentity | null) | undefined,
  metadataOnly: boolean,
  row: () => SessionSearchFileRow | undefined,
  closed: () => boolean,
  onContentAccepted?: (revision: string) => void,
  context?: { read: SessionSearchReadContext; store: SessionSearchStore }
): SessionSearchFileWrite | null {
  if (
    context &&
    !context.store.catalogWork.matches({
      candidate,
      version: context.read.receipt.version,
      force: context.read.receipt.force,
      metadata: context.read.receipt.metadata,
      receipt: context.read.receipt
    })
  ) {
    return null
  }
  const admission = candidates?.admission(candidate)
  if (admission?.allowed === false || (metadataOnly && admission?.contentRequired)) {
    return null
  }
  const original = writer.beginWrite(candidate, mode, previousByteOffset, identity)
  if (!original) {
    return null
  }
  const write = trackSessionSearchMetadataWrite(
    db,
    candidate.file.path,
    row,
    original,
    metadataOnly
  )
  let reason: string | undefined
  const onAccepted =
    onContentAccepted ??
    (context
      ? (revision: string) => {
          reason = revision
        }
      : undefined)
  const valid = () =>
    !closed() &&
    (!candidates || candidates.admission(candidate).revision === (admission?.revision ?? ''))
  const handle: SessionSearchFileWrite = {
    ...write,
    cancelled: () => !valid() || (write.cancelled?.() ?? false),
    add: (message) => {
      if (valid()) {
        write.add(message)
      }
    },
    addPrepared: (rows, hash) => {
      if (valid()) {
        write.addPrepared?.(rows, hash)
      }
    },
    commit: (outcome) => {
      if (!valid()) {
        write.discard()
        return false
      }
      const accepted = write.commit(outcome)
      if (accepted && admission) {
        if (onAccepted) {
          onAccepted(admission.revision)
        } else {
          candidates?.execute({
            kind: 'acknowledge',
            path: candidate.file.path,
            agent: candidate.agent,
            revision: admission.revision,
            metadataOnly
          })
        }
      }
      return accepted
    }
  }
  return context && !onContentAccepted
    ? bindSessionSearchReadSettlement(
        handle,
        context.read,
        () =>
          reason === undefined
            ? undefined
            : settleSessionSearchContent(
                context.store,
                candidate,
                reason,
                metadataOnly,
                context.read.receipt
              ),
        () => invalidateSessionSearchAcceptedContent(context.store, candidate.file.path)
      )
    : handle
}
