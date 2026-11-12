import { performance } from 'node:perf_hooks'
import type { TerminalHost } from '../terminal-host/terminal-host'
import { recordDaemonStreamBacklogEvent } from '../transport/stream/daemon-stream-backlog-probe'
import type { GetSnapshotRequest, GetSnapshotResult } from '../protocol/daemon-rpc-contract'
import type { FlushHistoryRequest, FlushHistoryResult } from '../protocol/daemon-history-protocol'
import type { TerminalHistoryJournals } from '../history/journal/terminal-history-journals'
import { resolveDaemonSessionScrollbackRows } from '../sessions/daemon-session-scrollback-window'
import type { CreateOrAttachResult } from '../terminal-host/terminal-host-create-contract'
import { TerminalAttachCanceledError } from '../protocol/daemon-errors'
import { TerminalHistoryUnavailableError } from '../protocol/daemon-history-protocol'
import { awaitDaemonValueWithinCallerDeadline } from '../launch/daemon-request-deadline'

// Bounded like the former adapter overlay; the live terminal keeps running meanwhile.
const ATTACH_HISTORY_IMAGE_DEADLINE_MS = 5_000

export function answerDaemonHistoryRequest(
  host: TerminalHost,
  request: GetSnapshotRequest | FlushHistoryRequest
): Promise<GetSnapshotResult | FlushHistoryResult> {
  if (request.type === 'flushHistory') {
    return flushDaemonHistory(host.historyJournals, request.payload)
  }
  const requested = request.payload.scrollbackRows
  const scrollbackRows =
    typeof requested === 'number' && Number.isFinite(requested)
      ? Math.max(0, Math.min(50_000, Math.floor(requested)))
      : undefined
  return host.historyJournals
    ? readDaemonHistorySnapshot(host, host.historyJournals, {
        ...request.payload,
        scrollbackRows
      })
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

/** Live window from the 1k model; deeper reads replay the journal's cut, never rebasing it. */
async function readDaemonHistorySnapshot(
  host: TerminalHost,
  journals: TerminalHistoryJournals,
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
  if (
    journal.gapped ||
    (scrollbackRows !== undefined && scrollbackRows <= resolveDaemonSessionScrollbackRows())
  ) {
    const snapshot = await host.getSettledSnapshot(sessionId, { scrollbackRows })
    return snapshot && journals.live(sessionId, session.incarnationId) === journal
      ? { snapshot, history: journal.outcome(snapshot.outputSequence ?? 0) }
      : unavailable
  }
  // Settle ownership proof first so the cut's owner matches its bytes.
  await session.settleShellOwnershipConfirmation()
  const capture = () => (journal.session ? journal.captureCut() : null)
  const image = await journal.readImage(capture, { scrollbackRows })
  if (journals.live(sessionId, session.incarnationId) !== journal) {
    // The incarnation it was read for no longer owns the ID; never publish it for a successor.
    return unavailable
  }
  if (image) {
    return { snapshot: image.snapshot, history: image.outcome }
  }
  return journal.gapped
    ? readDaemonHistorySnapshot(host, journals, {
        sessionId,
        scrollbackRows: 0,
        expectedIncarnationId: session.incarnationId
      })
    : unavailable
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

/**
 * Attach builds the image at the server-owned cut while this attempt's token is still held.
 * Failure detaches only that token, so a later attempt keeps its stream and input.
 */
export async function withAttachHistoryImage(
  host: TerminalHost,
  sessionId: string,
  result: CreateOrAttachResult,
  isCanceled: () => boolean
): Promise<CreateOrAttachResult> {
  const journal = host.historyJournals?.live(sessionId, result.incarnationId)
  const cut = result.historyCut
  if (result.isNew || !cut) {
    const unavailable = { kind: 'unavailable' as const, incarnationId: result.incarnationId }
    return { ...result, history: journal?.outcome(0) ?? unavailable }
  }
  try {
    if (!journal || !result.snapshot) {
      throw new TerminalHistoryUnavailableError()
    }
    let timedOut = false
    const read = cut.gapped
      ? null
      : await awaitDaemonValueWithinCallerDeadline(
          journal.readImage(cut, { isCanceled: () => timedOut || isCanceled() }),
          Date.now() + ATTACH_HISTORY_IMAGE_DEADLINE_MS
        )
    timedOut = true
    const image = read?.completed ? read.value : null
    if (isCanceled()) {
      throw new TerminalAttachCanceledError(sessionId)
    }
    if (!image && !journal.gapped) {
      // Transient: the live owner is known, so the same ID retries; never presumed gone.
      throw new TerminalHistoryUnavailableError()
    }
    // Final membership check, with no await before the caller commits the attachment.
    if (
      host.historyJournals?.live(sessionId, result.incarnationId) !== journal ||
      !journal.hasAttachedClient(result.attachToken)
    ) {
      throw new TerminalAttachCanceledError(sessionId)
    }
    // A permanent gap still attaches the same live window, explicitly labelled.
    return image
      ? { ...result, snapshot: image.snapshot, history: image.outcome }
      : { ...result, history: journal.outcome(cut.outputSequence) }
  } catch (error) {
    host.detach(sessionId, result.attachToken)
    throw error
  }
}
