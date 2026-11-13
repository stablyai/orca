import { ownRetainedString } from '../../../shared/own-retained-string'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import type {
  TranscriptMessage,
  TranscriptReadOutcome,
  TranscriptSessionIdentity
} from '../../ai-vault/transcripts/session-transcript-consumers'
import {
  createAiVaultScanCancelledError,
  abandonRemoteSessionScanOnCancel
} from '../../ai-vault/scan-lifecycle/ai-vault-scan-cancellation'
import { EMPTY_CONTENT_HASH, foldContentHash } from '../storage/session-search-content-hash'
import { searchMessageRows } from '../storage/session-search-message-rows'
import type { SessionSearchFileWrite } from '../storage/session-search-index-writer'
import type {
  SearchWorkerCommand,
  SessionSearchSnapshotRow
} from './session-search-worker-protocol'
import { SessionSearchWorkerStoreBase } from './session-search-worker-store-base'

const TRANSFER_BYTES = 8 * 1024 * 1024
const BATCH_BYTES = 64 * 1024

export class SessionSearchWorkerStore extends SessionSearchWorkerStoreBase {
  beginWrite(
    candidate: SessionFileCandidate,
    mode: 'append' | 'replace',
    offset: number,
    identity?: () => TranscriptSessionIdentity | null,
    indexing = false,
    signal?: AbortSignal
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
    const post = (command: SearchWorkerCommand) => {
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
    void post({ op: 'begin', handle, candidate, mode, offset })
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
        const old = this.committed.get(candidate.file.path)
        const speculative: SessionSearchSnapshotRow = {
          path: candidate.file.path,
          identity:
            typeof candidate.file.dev === 'number' && typeof candidate.file.ino === 'number'
              ? { dev: candidate.file.dev, ino: candidate.file.ino }
              : null,
          mtimeMs: candidate.file.mtimeMs,
          sizeBytes: candidate.file.sizeBytes ?? null,
          sidecarMtimeMs:
            typeof candidate.file.sidecar === 'object' ? candidate.file.sidecar.mtimeMs : null,
          sidecarSizeBytes:
            typeof candidate.file.sidecar === 'object' ? candidate.file.sidecar.sizeBytes : null,
          state: 'current',
          failCount: 0,
          failedMtimeMs: null,
          byteOffset: outcome.byteOffset,
          prefixHash: outcome.prefixHash ?? null,
          agent: old?.agent ?? candidate.agent,
          contentHash: hash
        }
        this.speculative.set(candidate.file.path, speculative)
        void post({ op: 'finish', handle, outcome, hash })
          .then(() => {
            if (this.speculative.get(candidate.file.path) === speculative) {
              this.speculative.delete(candidate.file.path)
            }
            this.invalidations.delete(owner)
          })
          .catch(() => undefined)
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
