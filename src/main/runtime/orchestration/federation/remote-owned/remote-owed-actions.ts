import { z } from 'zod'
import { mapWithConcurrency } from '../../../../../shared/map-with-concurrency'
import { HelperStopOutcome } from '../../../../../shared/orchestration/workers/orchestration-worker-stop-receipt'
import { PeerRunCancelResult } from '../../../../../shared/orchestration/remote-owned-wire'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  deferRemoteDispatchStop,
  listOwedRemoteStops,
  remoteResendRetryAt,
  remoteStopKey,
  settleRemoteDispatchStop,
  type RemoteDispatchRow
} from '../../db/remote-owned/remote-dispatch-records'
import {
  closeRemoteRunLink,
  getRemoteRunLink,
  listOwedRemoteRunCancels,
  remoteRunLinkPinMatches,
  remoteServerPin,
  type RemoteRunLinkRow
} from '../../db/remote-owned/remote-run-links'
import { callRemoteOwnedServer, type RemoteOwnedRuntime } from './remote-owned-calls'
import { REMOTE_SERVER_UNREACHABLE_CODES } from './remote-server-unreachable'

const STOP_TIMEOUT_MS = 60_000
const CANCEL_TIMEOUT_MS = 120_000
// Enough to keep one slow server from holding every other owed action back.
const RESEND_CONCURRENCY = 4

/** Codes that mean the server never answered, or this Orca never sent: a resend keeps its key. */
const NO_ANSWER_CODES = new Set([
  ...REMOTE_SERVER_UNREACHABLE_CODES,
  'invalid_runtime_response',
  'peer_changed',
  'runtime_environment_changed',
  'server_required',
  'server_pairing_changed',
  'remote_link_closed'
])

/** Whether the server got the call and answered it, rather than this Orca never reaching it. */
export function serverAnswered(error: unknown): boolean {
  return error instanceof OrchestrationError && !NO_ANSWER_CODES.has(error.code)
}

/** The server answers for that link's work only under the pairing it was made with; a re-pair ends it. */
function closeOnPairingChange(
  runtime: RemoteOwnedRuntime,
  link: RemoteRunLinkRow,
  error: unknown
): boolean {
  if (
    error instanceof OrchestrationError &&
    (error.code === 'server_pairing_changed' || error.code === 'runtime_environment_changed')
  ) {
    const now = runtime.resolveOrchestrationWorkerServer(link.environment_id)
    if (!remoteRunLinkPinMatches(link, remoteServerPin(now))) {
      closeRemoteRunLink(runtime.getOrchestrationDb(), link.conversation_id, error.message)
      return true
    }
  }
  return false
}

const StopReceipt = z.object({
  state: z.string(),
  alreadySettled: z.boolean(),
  helperStopError: z.string().optional(),
  helpers: z.array(HelperStopOutcome).optional()
})

/** Proof a stop is done: the worker stopped or had already settled, and so did every helper, unless the user kept it open. */
export function isRemoteStopProof(receipt: unknown): boolean {
  const parsed = StopReceipt.safeParse(receipt)
  return (
    parsed.success &&
    (parsed.data.state === 'stopped' || parsed.data.alreadySettled) &&
    parsed.data.helperStopError === undefined &&
    (parsed.data.helpers ?? []).every((helper) =>
      ['stopped', 'already_finished', 'kept_open'].includes(helper.outcome)
    )
  )
}

/**
 * Sends the stop owed for a remote Dispatch under its current key and returns the server's receipt.
 * Only proof for the count it was sent under clears the debt; anything else leaves it owed.
 */
export async function sendOwedRemoteStop(
  runtime: RemoteOwnedRuntime,
  record: RemoteDispatchRow,
  now: () => number = Date.now
): Promise<unknown> {
  const db = runtime.getOrchestrationDb()
  const link = getRemoteRunLink(db, record.conversation_id)
  if (!link) {
    return undefined
  }
  try {
    const receipt = await callRemoteOwnedServer(runtime, link, {
      method: 'orchestration.workerStop',
      params: { dispatch: record.dispatch_id },
      timeoutMs: STOP_TIMEOUT_MS,
      requestId: remoteStopKey(record),
      whileLink: ['open']
    })
    if (isRemoteStopProof(receipt)) {
      settleRemoteDispatchStop(runtime.getOrchestrationDb(), record.dispatch_id, record.stop_count)
    } else {
      deferRemoteDispatchStop(runtime.getOrchestrationDb(), record, {
        answered: true,
        error: 'The server has not proven the stop yet.',
        retryAt: remoteResendRetryAt(record.stop_retries, now())
      })
    }
    return receipt
  } catch (error) {
    if (!closeOnPairingChange(runtime, link, error)) {
      deferRemoteDispatchStop(runtime.getOrchestrationDb(), record, {
        answered: serverAnswered(error),
        error: error instanceof Error ? error.message : String(error),
        retryAt: remoteResendRetryAt(record.stop_retries, now())
      })
    }
    throw error
  }
}

/**
 * Sends the cancel an A reset owes the server for one link. B closes the peer Run and runs its
 * ordinary stop on each live worker; the debt ends when it answers that none remain.
 */
export async function sendOwedRemoteRunCancel(
  runtime: RemoteOwnedRuntime,
  link: RemoteRunLinkRow,
  now: () => number = Date.now
): Promise<void> {
  if (!link.cancel_key) {
    return
  }
  const settle = (update: { closed: boolean; answered: boolean; error: string | null }): void => {
    runtime
      .getOrchestrationDb()
      .db.prepare(
        `UPDATE remote_run_links SET
           state = CASE WHEN ? THEN 'closed' ELSE state END,
           cancel_attempt = CASE WHEN ? THEN cancel_attempt + 1 ELSE cancel_attempt END,
           cancel_retries = cancel_retries + 1,
           cancel_retry_at = CASE WHEN ? THEN NULL ELSE ? END,
           last_error = ?
         WHERE conversation_id = ? AND state = 'cancel_owed' AND cancel_key = ? AND cancel_attempt = ?`
      )
      .run(
        update.closed ? 1 : 0,
        update.answered && !update.closed ? 1 : 0,
        update.closed ? 1 : 0,
        remoteResendRetryAt(link.cancel_retries, now()),
        update.error,
        link.conversation_id,
        link.cancel_key,
        link.cancel_attempt
      )
  }
  try {
    const answer = PeerRunCancelResult.parse(
      await callRemoteOwnedServer(runtime, link, {
        method: 'orchestration.peerRunCancel',
        params: {},
        timeoutMs: CANCEL_TIMEOUT_MS,
        requestId: `${link.cancel_key}.${link.cancel_attempt}`,
        whileLink: ['cancel_owed']
      })
    )
    settle({
      closed: answer.remaining === 0,
      answered: true,
      error:
        answer.remaining === 0 ? null : `${answer.remaining} workers there are not proven stopped.`
    })
  } catch (error) {
    if (closeOnPairingChange(runtime, link, error)) {
      return
    }
    settle({
      closed: false,
      answered: serverAnswered(error),
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/** Everything this Orca owes one server, resent from its pull loop until the server answers for it. */
export async function resendOwedRemoteActions(
  runtime: RemoteOwnedRuntime,
  db: OrchestrationDb,
  environmentId: string,
  options: { now?: () => number } = {}
): Promise<void> {
  const now = options.now ?? Date.now
  const due = (retryAt: number | null) => retryAt === null || retryAt <= now()
  const actions: (() => Promise<unknown>)[] = [
    ...listOwedRemoteStops(db, environmentId, now()).map(
      (record) => () => sendOwedRemoteStop(runtime, record, now)
    ),
    ...listOwedRemoteRunCancels(db, environmentId)
      .filter((link) => due(link.cancel_retry_at))
      .map((link) => () => sendOwedRemoteRunCancel(runtime, link, now))
  ]
  await mapWithConcurrency(actions, RESEND_CONCURRENCY, (action) => action().catch(() => undefined))
}
