import { launchTokenHash } from '../../../../../shared/agent-hook-listener/transport/agent-hook-spool'
import type { EnrichedAgentHookEventPayload } from '../../../../agent-hooks/server/server-types'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { recordDispatchNativeUsageIdentity } from '../../db/dispatch-context/dispatch-native-usage-identity'
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
    observedAt: session.observedAt
  })
}
