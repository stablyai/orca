import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { oweRemoteDispatchStop, remoteStopKey } from '../../db/remote-owned/remote-dispatch-records'
import { getOpenRemoteRunLink, type RemoteRunLinkRow } from '../../db/remote-owned/remote-run-links'
import { settleRemoteAttemptHere } from '../../db/remote-owned/remote-placements'
import { OrchestrationError } from '../../orchestration-error'
import type { RemoteForwardKey } from './remote-forward-caller'
import { inServerTerms, serverNeverAnswered } from './remote-owned-answers'
import { sendOwedRemoteStop } from './remote-owed-actions'
import { remoteServerName } from './remote-owned-reads'

/** A stop is owed until the server proves it; the ordinary stop answers when it can, and the pull loop resends otherwise. */
export async function stopRemoteWorker(
  runtime: OrcaRuntimeService,
  link: RemoteRunLinkRow,
  dispatchId: string,
  forward: RemoteForwardKey | undefined
): Promise<unknown> {
  const db = runtime.getOrchestrationDb()
  const server = remoteServerName(runtime, link.environment_id)
  const owed = oweRemoteDispatchStop(db, dispatchId, forward?.key ?? `stop:${randomUUID()}`)
  if (!owed) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Worker Dispatch ${dispatchId} was not found.`
    )
  }
  runtime.ensureOrchestrationFederationRelay(link.run_id)
  // The server knows this attempt by its stop key; the caller knows only its own request ID.
  const stopKey = forward && { key: remoteStopKey(owed.record), requestId: forward.requestId }
  try {
    return inServerTerms(await sendOwedRemoteStop(runtime, owed.record), {
      server,
      forward: stopKey,
      link: link
    })
  } catch (error) {
    if (!serverNeverAnswered(error) || !getOpenRemoteRunLink(db, link.conversation_id)) {
      throw inServerTerms(error, { server, forward: stopKey, link: link })
    }
    return settleUnansweredStop(runtime, link, dispatchId)
  }
}

/** The server did not answer a stop: the Task half runs here at once, as a local stop's does, and the stop stays owed until the server proves it. */
function settleUnansweredStop(
  runtime: OrcaRuntimeService,
  link: RemoteRunLinkRow,
  dispatchId: string
) {
  const server = remoteServerName(runtime, link.environment_id)
  settleRemoteAttemptHere(runtime.getOrchestrationDb(), dispatchId, 'stopped')
  return {
    dispatchId,
    state: 'stop_requested',
    server,
    next: `${server} did not answer, so its worker may still run there. Its Task is settled here, so it can be retried, and the stop is owed: this Orca sends it again until ${server} confirms the worker stopped.`
  }
}

/**
 * The server did not answer an abandon: as a local abandon, nothing is stopped; the Task half runs
 * here at once, so the Task can be retried, and the worker there is left to run.
 */
export function settleUnansweredAbandon(
  runtime: OrcaRuntimeService,
  link: RemoteRunLinkRow,
  dispatchId: string
) {
  const server = remoteServerName(runtime, link.environment_id)
  settleRemoteAttemptHere(runtime.getOrchestrationDb(), dispatchId, 'abandoned')
  return {
    dispatchId,
    state: 'abandoned',
    alreadySettled: false,
    stale: false,
    processAction: 'none',
    warning: `${server} did not answer, so it was not told and its worker may still run there. The Task is settled here, so it can be retried; no process was stopped.`,
    residualResources: []
  }
}
