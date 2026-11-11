import { sessionSearchForegroundTransfer } from './session-search-foreground-transfer'
import { SELF_CONTAINED_TRANSCRIPT_AGENTS } from './session-search-index-consumer'
import { ownRetainedString } from '../../shared/own-retained-string'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type {
  TranscriptReadStart,
  TranscriptMessage,
  TranscriptReadOutcome,
  TranscriptSessionIdentity
} from '../ai-vault/transcripts/session-transcript-consumers'
import {
  createAiVaultScanCancelledError,
  abandonRemoteSessionScanOnCancel
} from '../ai-vault/ai-vault-scan-cancellation'
import { EMPTY_CONTENT_HASH, foldContentHash } from './session-search-content-hash'
import { searchMessageRows } from './session-search-message-rows'
import type { SessionSearchFileWrite } from './session-search-index-writer'
import type {
  SearchWorkerCommand,
  SearchWorkerResponse,
  SessionSearchSnapshotRow
} from './session-search-worker-protocol'
import { SessionSearchWorkerStoreBase } from './session-search-worker-store-base'

const TRANSFER_BYTES = 8 * 1024 * 1024
const BATCH_BYTES = 64 * 1024

export class SessionSearchWorkerStore extends SessionSearchWorkerStoreBase {
  beginUnpreparedWrite(start: TranscriptReadStart): SessionSearchFileWrite | null {
    if (!this.acceptingReads || this.bytes >= TRANSFER_BYTES) {
      return null
    }
    const epoch = this.client.epoch
    const coverageEpoch = this.snapshotEpoch
    const owner = new AbortController()
    this.invalidations.set(owner, start.candidate.file.path)
    const signal = start.signal ? AbortSignal.any([owner.signal, start.signal]) : owner.signal
    return sessionSearchForegroundTransfer(
      { ...start, signal },
      ++this.nextHandle,
      {
        send: (command) => this.send(command),
        active: () =>
          this.acceptingReads &&
          this.client.epoch === epoch &&
          this.snapshotEpoch === coverageEpoch,
        retain: (bytes) => {
          if (!start.indexing && this.bytes + bytes > TRANSFER_BYTES) {
            return false
          }
          this.bytes += bytes
          return true
        },
        release: (bytes) => {
          this.bytes -= bytes
        },
        finished: () => {
          this.invalidations.delete(owner)
        }
      },
      SELF_CONTAINED_TRANSCRIPT_AGENTS[start.candidate.agent] &&
        (start.candidate.file.sidecar === undefined || start.candidate.file.sidecar === 'none')
    )
  }

  beginWrite(
    candidate: SessionFileCandidate,
    mode: 'append' | 'replace',
    offset: number,
    identity?: () => TranscriptSessionIdentity | null,
    indexing = false,
    signal?: AbortSignal,
    metadataOnly = false
  ): SessionSearchFileWrite | null {
    if (
      !this.acceptingReads ||
      (!indexing && this.bytes >= TRANSFER_BYTES) ||
      (this.cutoff !== null && candidate.file.mtimeMs < this.cutoff)
    ) {
      return null
    }
    const handle = ++this.nextHandle
    const epoch = this.client.epoch
    const snapshotEpoch = this.snapshotEpoch
    const owner = new AbortController()
    this.invalidations.set(owner, candidate.file.path)
    const readSignal = signal ? AbortSignal.any([owner.signal, signal]) : owner.signal
    let settlement: Promise<boolean> = Promise.resolve(false)
    let ended = false
    let cancelled = false
    let failed = false
    let rows: TranscriptMessage[] = []
    let size = 0
    let hash =
      mode === 'append'
        ? (this.row(candidate.file.path, null)?.contentHash ?? EMPTY_CONTENT_HASH)
        : EMPTY_CONTENT_HASH
    const active = () =>
      !cancelled &&
      this.acceptingReads &&
      epoch === this.client.epoch &&
      snapshotEpoch === this.snapshotEpoch &&
      !readSignal.aborted
    const valid = () => active() && !failed
    const post = (command: SearchWorkerCommand): Promise<SearchWorkerResponse> => {
      if (!valid()) {
        return Promise.resolve({ id: 0, accepted: false })
      }
      return this.send(command)
        .then((response) => {
          if (response.failure === 'write' && !failed) {
            failed = true
            this.setFileState(candidate.file.path, 'failed', candidate.file.mtimeMs)
            for (const [dependent, path] of this.invalidations) {
              if (dependent !== owner && path === candidate.file.path) {
                dependent.abort()
              }
            }
            this.speculative.delete(candidate.file.path)
          } else if (response.accepted === false && !failed) {
            cancelled = true
            owner.abort()
            this.speculative.delete(candidate.file.path)
          }
          return response
        })
        .catch(() => {
          cancelled = true
          return { id: 0, accepted: false }
        })
    }
    void post({ op: 'begin', metadataOnly, handle, candidate, mode, offset })
    const discard = () => {
      cancelled = true
      this.bytes -= size
      rows = []
      size = 0
      if (this.acceptingReads && epoch === this.client.epoch && !ended) {
        ended = true
        void this.send({ op: 'discard', handle }).catch(() => undefined)
      }
      this.speculative.delete(candidate.file.path)
      this.invalidations.delete(owner)
    }
    owner.signal.addEventListener('abort', discard, { once: true })
    const batch = () => {
      if (!rows.length || !valid()) {
        return
      }
      const payload = rows
      const bytes = size
      rows = []
      size = 0
      const sent = post({
        op: 'batch',
        handle,
        rows: payload,
        hash,
        identity: identity?.() ?? null
      })
      this.credits.add(sent)
      void sent
        .finally(() => {
          this.bytes -= bytes
          this.credits.delete(sent)
        })
        .catch(() => undefined)
    }
    return {
      settled: () => settlement,
      failed: () => failed,
      cancelled: () => !active(),
      drain: async () => {
        batch()
        if (!active()) {
          throw createAiVaultScanCancelledError()
        }
        if (this.bytes >= TRANSFER_BYTES) {
          await abandonRemoteSessionScanOnCancel(Promise.allSettled(this.credits), readSignal)
        }
        if (!active()) {
          throw createAiVaultScanCancelledError()
        }
      },
      add: (message) => {
        if (!valid()) {
          return
        }
        hash = foldContentHash(hash, [message])
        for (const row of searchMessageRows([message])) {
          row.text = ownRetainedString(row.text)
          rows.push(row)
          const bytes = row.text.length * 2 + 256
          size += bytes
          this.bytes += bytes
          if (!indexing && this.bytes >= TRANSFER_BYTES) {
            discard()
            return
          }
          if (size >= BATCH_BYTES) {
            batch()
          }
        }
      },
      addPrepared: () => {
        throw new Error('Prepared rows belong to the writer')
      },
      commit: (outcome: TranscriptReadOutcome) => {
        if (!valid()) {
          discard()
          return false
        }
        batch()
        ended = true
        const old = this.coverage.get(candidate.file.path)
        const speculative: SessionSearchSnapshotRow = {
          path: candidate.file.path,
          identity:
            typeof candidate.file.dev === 'number' && typeof candidate.file.ino === 'number'
              ? { dev: candidate.file.dev, ino: candidate.file.ino }
              : null,
          mtimeMs: candidate.file.mtimeMs,
          sizeBytes: candidate.file.sizeBytes ?? null,
          state: 'current',
          failCount: 0,
          failedMtimeMs: null,
          byteOffset: outcome.byteOffset,
          prefixHash: outcome.prefixHash ?? null,
          agent: old?.agent ?? candidate.agent,
          contentHash: hash
        }
        this.speculative.set(candidate.file.path, speculative)
        settlement = post({ op: 'finish', handle, outcome, hash })
          .then((response) => {
            const accepted =
              response.accepted === true &&
              valid() &&
              response.deltas?.some(
                (delta) => delta.path === candidate.file.path && delta.row?.state === 'current'
              ) === true
            if (this.speculative.get(candidate.file.path) === speculative) {
              this.speculative.delete(candidate.file.path)
            }
            this.invalidations.delete(owner)
            return accepted
          })
          .catch(() => false)
        return true
      },
      discard: () => {
        if (!ended) {
          discard()
        }
      }
    }
  }
}
