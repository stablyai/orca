import { ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS } from '../../../../../shared/orchestration/orchestration-timing-budgets'
import {
  ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY,
  ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORK_TARGET_FOLLOW_UP_RUNTIME_CAPABILITY
} from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcContext } from '../../../rpc/core'
import { startsInChatLineage } from '../../../rpc/methods/orchestration/worker/start/worker-chat-lineage'
import type { WorkerStartParams } from '../../../../../shared/rpc-contract/orchestration/orchestration-worker-start-params'
import type { z } from 'zod'
import type { OrchestrationWorkerServer } from '../environment-transport'
import { getOrchestrationPeerCapabilityCache } from '../orchestration-peer-capability-cache'

type StartParams = z.infer<typeof WorkerStartParams>

/** Whether the server runs the workers placed on it as its own; an older one keeps today's remote attachments. */
export async function serverOwnsPlacedWorkers(
  runtime: OrcaRuntimeService,
  server: OrchestrationWorkerServer
): Promise<boolean> {
  return (
    await serverCapabilityDecision(
      runtime,
      server,
      ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY
    )
  ).supported
}

/** Resolve work-target follow-up support together with the exact server runtime instance that proved it. */
export async function resolveWorkTargetFollowUpCapability(
  runtime: OrcaRuntimeService,
  server: OrchestrationWorkerServer,
  options?: { force?: true }
): Promise<{ supported: boolean; runtimeId: string | null }> {
  const decision = await serverCapabilityDecision(
    runtime,
    server,
    ORCHESTRATION_WORK_TARGET_FOLLOW_UP_RUNTIME_CAPABILITY,
    options
  )
  const runtimeId =
    typeof decision.runtimeEpoch === 'string' && decision.runtimeEpoch.length > 0
      ? decision.runtimeEpoch
      : null
  return { supported: decision.supported && runtimeId !== null, runtimeId }
}

/** Drop cached follow-up capability proof after the paired server's runtime instance changed. */
export function invalidateWorkTargetFollowUpCapability(
  runtime: OrcaRuntimeService,
  server: OrchestrationWorkerServer,
  staleRuntimeId?: string
): void {
  getOrchestrationPeerCapabilityCache(runtime).invalidateEpoch(
    server.peerFingerprint,
    staleRuntimeId
  )
}

/** The lineage a start carries to the server: only when its caller is in one and the server takes it.
 *  An older server would ignore it and keep its own settings, as before. */
export async function forwardedChatLineage(
  runtime: OrcaRuntimeService,
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>,
  params: StartParams,
  caller: RpcContext['orchestrationCaller'],
  server: OrchestrationWorkerServer
): Promise<{ chatLineage?: true }> {
  return startsInChatLineage(runtime, db, params, caller) &&
    (await serverCapabilityDecision(runtime, server, ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY))
      .supported
    ? { chatLineage: true }
    : {}
}

async function serverCapabilityDecision(
  runtime: OrcaRuntimeService,
  server: OrchestrationWorkerServer,
  capability: string,
  options?: { force?: true }
) {
  return getOrchestrationPeerCapabilityCache(runtime).resolve({
    peerFingerprint: server.peerFingerprint,
    expectedRuntimeEpoch: null,
    capability,
    probe: async () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: status.get answers RuntimeStatus; the cache reads only its capabilities and runtime ID.
      (await runtime.callOrchestrationWorkerServer(
        server.environmentId,
        'status.get',
        undefined,
        ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS,
        undefined,
        {
          expectedEnvironmentPairingRevision: server.pairingRevision,
          ...(options?.force ? { forceStatusProbe: true as const } : {})
        }
      )) as RuntimeStatus
  })
}
