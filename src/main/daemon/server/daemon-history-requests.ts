import { performance } from 'node:perf_hooks'
import type { Socket } from 'node:net'
import type { TerminalHost } from '../terminal-host/terminal-host'
import { recordDaemonStreamBacklogEvent } from '../transport/stream/daemon-stream-backlog-probe'
import type { GetSnapshotRequest, GetSnapshotResult } from '../protocol/daemon-rpc-contract'
import type { FlushHistoryRequest, FlushHistoryResult } from '../protocol/daemon-history-protocol'
import type { TerminalHistoryJournals } from '../history/journal/terminal-history-journals'
import { resolveDaemonSessionScrollbackRows } from '../sessions/daemon-session-scrollback-window'
import { encodeNdjson } from '../../../shared/main-process-ndjson-framer'
import { withPreparedReply } from './daemon-reply-obligation'
// Deep reads end by the caller's own budget; a client that sends none still gets a finite one.
const DEEP_SNAPSHOT_BUDGET_MS = 30_000

export async function answerDaemonHistoryRequest(
  host: TerminalHost,
  request: GetSnapshotRequest | FlushHistoryRequest,
  socket: Socket | undefined
): Promise<GetSnapshotResult | FlushHistoryResult> {
  // Aborts when this client's control socket closes, including one already closed.
  const disconnect = new AbortController()
  const abort = (): void => disconnect.abort(new Error('client_disconnected'))
  if (!socket || socket.destroyed) {
    abort()
  }
  socket?.once('close', abort)
  try {
    return await answerWithin(host, request, disconnect.signal)
  } finally {
    socket?.off('close', abort)
  }
}

function answerWithin(
  host: TerminalHost,
  request: GetSnapshotRequest | FlushHistoryRequest,
  disconnected: AbortSignal
): Promise<GetSnapshotResult | FlushHistoryResult> {
  if (request.type === 'flushHistory') {
    return flushDaemonHistory(host.historyJournals, request.payload)
  }
  const requested = request.payload.scrollbackRows
  const scrollbackRows =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.max(0, Math.min(50_000, Math.floor(requested)))
      : undefined
  const budget = request.payload.remainingBudgetMs
  const budgetMs =
    typeof budget === 'number' && Number.isFinite(budget)
      ? Math.max(1, Math.min(DEEP_SNAPSHOT_BUDGET_MS, budget))
      : DEEP_SNAPSHOT_BUDGET_MS
  return host.historyJournals
    ? readDaemonHistorySnapshot(
        host,
        host.historyJournals,
        {
          id: request.id,
          signal: AbortSignal.any([disconnected, AbortSignal.timeout(budgetMs)])
        },
        { ...request.payload, scrollbackRows }
      )
    : readLiveDaemonSnapshot(host, request.payload.sessionId, scrollbackRows)
}

async function readLiveDaemonSnapshot(
  host: TerminalHost,
  sessionId: string,
  scrollbackRows: number | undefined
): Promise<GetSnapshotResult> {
  const startedAt = performance.now()
  const snapshot = await host.getSettledSnapshot(sessionId, { scrollbackRows })
  const snapshotMs = performance.now() - startedAt
  if (snapshotMs >= 25) {
    recordDaemonStreamBacklogEvent('slowGetSnapshot', {
      sessionIdSuffix: sessionId.slice(-10),
      snapshotMs: Math.round(snapshotMs)
    })
  }
  return { snapshot }
}

/** Live window from the 1k model; deeper reads share one flight and the latest derived answer. */
async function readDaemonHistorySnapshot(
  host: TerminalHost,
  journals: TerminalHistoryJournals,
  request: { id: string; signal: AbortSignal },
  payload: GetSnapshotRequest['payload']
): Promise<GetSnapshotResult> {
  const { sessionId, expectedIncarnationId, scrollbackRows } = payload
  const journal = journals.live(sessionId, expectedIncarnationId)
  const session = journal?.session
  if (!journal || !session) {
    return { snapshot: null, history: { kind: 'unavailable' } }
  }
  const unavailable: GetSnapshotResult = {
    snapshot: null,
    history: { kind: 'unavailable', incarnationId: session.incarnationId }
  }
  // Public live0 never waits for deep admission, the cold lane or the cache.
  if (scrollbackRows !== undefined && scrollbackRows <= resolveDaemonSessionScrollbackRows()) {
    const snapshot = await host.getSettledSnapshot(sessionId, { scrollbackRows })
    return snapshot && journals.live(sessionId, session.incarnationId) === journal
      ? { snapshot, history: journal.outcome(snapshot.outputSequence ?? 0) }
      : unavailable
  }
  // Past a gap no deeper answer exists; the live window stays its own operation.
  const consumer = journal.gapped ? null : journals.reads.admit(request.signal)
  if (!consumer) {
    return unavailable
  }
  const failed = (): GetSnapshotResult =>
    withPreparedReply({ ...unavailable }, { release: () => consumer.release() })
  try {
    const found = await consumer.acquire(journal, scrollbackRows, async () => {
      // Settle ownership proof and held startup bytes so the cut's owner matches its bytes.
      await session.settleShellOwnershipConfirmation()
      session.snapshotBarrier()
    })
    const ready =
      found === 'image' ||
      (found !== null && found.capture() && (await consumer.awaitFlight(found)))
    const image = consumer.image
    // The incarnation it was read for must still own the ID; never publish it for a successor.
    if (!ready || !image || journals.live(sessionId, session.incarnationId) !== journal) {
      return failed()
    }
    const result: GetSnapshotResult = { snapshot: image.snapshot, history: image.outcome }
    // The existing encoder, once; an over-long line fails honestly, never as a smaller image.
    const line = encodeNdjson({ id: request.id, ok: true, payload: result })
    return withPreparedReply(result, { line, release: () => consumer.release() })
  } catch {
    return failed()
  }
}

async function flushDaemonHistory(
  journals: TerminalHistoryJournals | undefined,
  payload: FlushHistoryRequest['payload']
): Promise<FlushHistoryResult> {
  const journal = journals?.live(payload.sessionId, payload.expectedIncarnationId)
  if (!journal?.session) {
    return { status: 'unavailable' }
  }
  if (payload.final) {
    // A final capture includes parser-held bytes, as the teardown snapshot did.
    journal.session.prepareForFinalSnapshot()
  }
  const committed = await journal.flush({ final: payload.final === true })
  return { status: committed ? 'committed' : 'unavailable' }
}
