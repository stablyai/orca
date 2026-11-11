import type { TranscriptReadStart } from '../ai-vault/transcripts/session-transcript-consumers'
import type { SessionSearchFileWrite } from './storage/session-search-index-writer'
import type {
  SearchWorkerCommand,
  SearchWorkerResponse
} from './worker/session-search-worker-protocol'
import type { SessionSearchReadEvent } from './session-search-foreground-write'
import { EMPTY_CONTENT_HASH } from './storage/session-search-content-hash'
import { createAiVaultScanCancelledError } from '../ai-vault/ai-vault-scan-cancellation'

export type SessionSearchForegroundTransport = {
  send(command: SearchWorkerCommand): Promise<SearchWorkerResponse>
  active(): boolean
  retain(bytes: number): boolean
  release(bytes: number): void
  finished(): void
}

/** History never waits for admission; pressure cancels only this bounded search transfer. */
export function sessionSearchForegroundTransfer(
  start: TranscriptReadStart,
  handle: number,
  transport: SessionSearchForegroundTransport,
  allowCovered: boolean
): SessionSearchFileWrite {
  let ended = false
  let cancelled = false
  let failed = false
  let prefixTarget: number | null | undefined
  let disposition: SearchWorkerResponse['admission']
  let events: SessionSearchReadEvent[] = []
  let bytes = 0
  let settlement = Promise.resolve(false)
  const pending = new Set<Promise<unknown>>()
  const active = () => !cancelled && transport.active() && !start.signal?.aborted
  const valid = () => active() && !failed
  const post = (command: SearchWorkerCommand) => {
    const request = transport
      .send(command)
      .then((response) => {
        if (response.failure) {
          failed = true
        }
        if (response.accepted === false) {
          cancelled = true
        }
        return response
      })
      .catch((): SearchWorkerResponse => {
        cancelled = true
        return { id: 0, accepted: false }
      })
    pending.add(request)
    void request.finally(() => pending.delete(request))
    return request
  }
  const admission = post({
    op: 'begin',
    handle,
    candidate: start.candidate,
    mode: start.mode,
    offset: start.previousByteOffset,
    unprepared: { allowCovered, canProvePrefix: start.mode === 'replace' && !!start.identity }
  }).then((response) => {
    disposition = response.admission
    if (disposition === 'covered') {
      transport.release(bytes)
      events = []
      bytes = 0
    } else if (disposition !== 'target') {
      cancelled = true
    }
    if ('prefixTarget' in response) {
      prefixTarget = response.prefixTarget
    }
  })
  const flush = () => {
    if (!events.length || disposition !== 'target') {
      return
    }
    const payload = events
    const retained = bytes
    events = []
    bytes = 0
    void post({
      op: 'read-batch',
      handle,
      events: payload,
      identity: start.identity?.() ?? null
    }).finally(() => transport.release(retained))
  }
  const discard = () => {
    cancelled = true
    transport.release(bytes)
    bytes = 0
    events = []
    if (!ended && transport.active()) {
      ended = true
      void transport.send({ op: 'discard', handle }).catch(() => undefined)
    }
    transport.finished()
  }
  const stage = (event: SessionSearchReadEvent) => {
    if (!valid() || disposition === 'covered') {
      return
    }
    const size = event.kind === 'message' ? event.message.text.length * 2 + 256 : 160
    if (!transport.retain(size)) {
      discard()
      return
    }
    events.push(event)
    bytes += size
    if (bytes >= 64 * 1024 || events.length >= 256) {
      flush()
    }
  }
  start.signal?.addEventListener('abort', discard, { once: true })
  return {
    drain: async () => {
      await admission
      flush()
      await Promise.allSettled(pending)
      if (!valid()) {
        throw createAiVaultScanCancelledError()
      }
    },
    add: (message) => stage({ kind: 'message', message }),
    needsPrefix: (offset) =>
      valid() &&
      disposition !== 'covered' &&
      (prefixTarget === undefined || prefixTarget === offset),
    prefixReached: (offset, digest) => stage({ kind: 'prefix', offset, digest }),
    failed: () => failed,
    cancelled: () => !active(),
    settled: () => settlement,
    commit: (outcome) => {
      if (!valid()) {
        discard()
        return false
      }
      ended = true
      settlement = admission.then(async () => {
        if (!valid()) {
          transport.release(bytes)
          events = []
          bytes = 0
          if (transport.active()) {
            await transport.send({ op: 'discard', handle }).catch(() => undefined)
          }
          transport.finished()
          return false
        }
        flush()
        const response = await post({ op: 'finish', handle, outcome, hash: EMPTY_CONTENT_HASH })
        transport.finished()
        return response.accepted === true && valid()
      })
      return true
    },
    discard: () => {
      if (!ended) {
        discard()
      }
    }
  }
}
