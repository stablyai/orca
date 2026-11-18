import { launchTokenHash } from '../../../../../shared/agent-hook-listener/transport/agent-hook-spool'
import type { EnrichedAgentHookEventPayload } from '../../../../agent-hooks/server/server-types'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  nativeSessionHeldByOtherDispatch,
  readOpenNativeUsageInterval,
  recordDispatchNativeUsageIdentity,
  settleDispatchNativeUsageInterval,
  type NativeUsageIntervalState
} from '../../db/dispatch-context/dispatch-native-usage-identity'
import {
  NATIVE_USAGE_INTERVAL_AGENTS,
  nativeTranscriptFileIdentity,
  scanFreshNativeTranscript
} from './native-usage-interval-scan'
import { orchestrationTimestampToMs } from '../../../rpc/methods/orchestration/worker/output/worker-output'

/** Only an admitted live hook bound to the worker at ingestion can name its provider session. */
export function captureDispatchNativeUsageIdentity(
  runtime: Pick<OrcaRuntimeService, 'getExistingOrchestrationDb' | 'getExactWorkerProviderSession'>,
  event: EnrichedAgentHookEventPayload,
  binding: { dispatchId: string; terminalHandle: string; processIncarnation: string }
): void {
  if (
    event.isReplay ||
    event.restoredUnconfirmed ||
    event.providerSessionOnly ||
    event.identityOnly ||
    event.programStatusOnly ||
    event.observation?.origin !== 'hook' ||
    !event.providerSession ||
    !event.launchToken
  ) {
    return
  }
  const db = runtime.getExistingOrchestrationDb()
  const worker = db?.getWorkerDispatch(binding.dispatchId)
  const dispatch = db?.getDispatchContextById(binding.dispatchId)
  if (!db || !worker || !dispatch?.host_scope) {
    return
  }
  const session = runtime.getExactWorkerProviderSession(
    binding.terminalHandle,
    orchestrationTimestampToMs(worker.created_at)
  )
  if (
    !session?.launchTokenHash ||
    session.launchTokenHash !== launchTokenHash(event.launchToken) ||
    session.paneKey !== event.paneKey ||
    session.processIncarnation !== binding.processIncarnation ||
    session.agent !== event.payload.agentType ||
    session.providerSession.id !== event.providerSession.id ||
    session.observedAt !== event.receivedAt
  ) {
    return
  }
  recordDispatchNativeUsageIdentity(db, binding.dispatchId, {
    status: 'observed',
    agent: session.agent,
    sessionId: session.providerSession.id,
    paneKey: session.paneKey,
    processIncarnation: session.processIncarnation,
    hostScope: dispatch.host_scope,
    launchTokenHash: session.launchTokenHash,
    observedAt: session.observedAt,
    interval: startNativeUsageInterval(
      db,
      binding.dispatchId,
      session,
      orchestrationTimestampToMs(worker.created_at)
    )
  })
}

function startNativeUsageInterval(
  db: OrchestrationDb,
  dispatchId: string,
  session: NonNullable<ReturnType<OrcaRuntimeService['getExactWorkerProviderSession']>>,
  notBeforeMs: number
): NativeUsageIntervalState {
  // Only a local PTY's transcript is readable by the Orca that attests the process.
  if (session.connectionId !== null || session.wslDistro) {
    return { status: 'unavailable', reason: 'host_not_local' }
  }
  if (!NATIVE_USAGE_INTERVAL_AGENTS.has(session.agent)) {
    return { status: 'unavailable', reason: 'agent_unsupported' }
  }
  const transcriptPath = session.providerSession.transcriptPath
  if (!transcriptPath) {
    return { status: 'unavailable', reason: 'start_boundary_missing' }
  }
  if (nativeSessionHeldByOtherDispatch(db, dispatchId, session.agent, session.providerSession.id)) {
    return { status: 'unavailable', reason: 'session_shared' }
  }
  return {
    status: 'open',
    transcriptPath,
    startFile: nativeTranscriptFileIdentity(transcriptPath),
    notBeforeMs
  }
}

/** Close the exclusive interval at release/stop, before the terminal is closed. */
export function settleDispatchNativeUsageIntervalAtRelease(
  runtime: Pick<OrcaRuntimeService, 'getExactWorkerProviderSession'>,
  db: OrchestrationDb,
  dispatchId: string,
  terminalHandle: string,
  attachedAtMs: number
): void {
  const held = readOpenNativeUsageInterval(db, dispatchId)
  if (!held) {
    return
  }
  const interval = held.interval
  if (!interval || interval.status !== 'open') {
    // Settles a missing start boundary; an already-settled outcome is preserved.
    settleDispatchNativeUsageInterval(db, dispatchId, {
      status: 'unavailable',
      reason: 'start_boundary_missing'
    })
    return
  }
  const identity = db.getDispatchContextById(dispatchId)?.native_usage_identity
  const stored = identity ? JSON.parse(identity) : null
  const session = runtime.getExactWorkerProviderSession(terminalHandle, attachedAtMs)
  if (
    !session ||
    session.launchTokenHash !== stored?.launchTokenHash ||
    session.processIncarnation !== stored?.processIncarnation ||
    session.paneKey !== stored?.paneKey ||
    session.agent !== held.agent ||
    session.providerSession.id !== held.sessionId ||
    session.providerSession.transcriptPath !== interval.transcriptPath
  ) {
    settleDispatchNativeUsageInterval(db, dispatchId, {
      status: 'unavailable',
      reason: 'session_changed'
    })
    return
  }
  if (nativeSessionHeldByOtherDispatch(db, dispatchId, held.agent, held.sessionId)) {
    settleDispatchNativeUsageInterval(db, dispatchId, {
      status: 'unavailable',
      reason: 'session_shared'
    })
    return
  }
  const scan = scanFreshNativeTranscript({
    path: interval.transcriptPath,
    sessionId: held.sessionId,
    notBeforeMs: interval.notBeforeMs,
    startFile: interval.startFile
  })
  settleDispatchNativeUsageInterval(
    db,
    dispatchId,
    scan.status === 'closed'
      ? {
          status: 'closed',
          transcriptPath: interval.transcriptPath,
          file: scan.file,
          startOffset: 0,
          endOffset: scan.endOffset,
          sha256: scan.sha256,
          closedAt: Date.now()
        }
      : scan
  )
}
