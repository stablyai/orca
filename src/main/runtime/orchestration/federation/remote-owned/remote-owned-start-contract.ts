import type { z } from 'zod'
import type { WorkerStartParams } from '../../../../../shared/rpc-contract/orchestration/orchestration-worker-start-params'
import {
  ORCHESTRATION_BOT_LINEAGE_RUNTIME_CAPABILITY,
  ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY,
  ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY
} from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS } from '../../../../../shared/orchestration/orchestration-timing-budgets'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { startsInChatLineage } from '../../../rpc/methods/orchestration/worker/start/worker-chat-lineage'
import type { WorkerStartInput } from '../../../rpc/methods/orchestration/worker/start/worker-start-input'
import { getOrchestrationPeerCapabilityCache } from '../orchestration-peer-capability-cache'
import type { OrchestrationWorkerServer } from '../environment-transport'

type StartParams = z.infer<typeof WorkerStartParams>

export async function serverSupports(
  runtime: OrcaRuntimeService,
  server: OrchestrationWorkerServer,
  capability: string
): Promise<boolean> {
  const decision = await getOrchestrationPeerCapabilityCache(runtime).resolve({
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
        { expectedEnvironmentPairingRevision: server.pairingRevision }
      )) as RuntimeStatus
  })
  return decision.supported
}

export async function serverOwnsPlacedWorkers(
  runtime: OrcaRuntimeService,
  server: OrchestrationWorkerServer
): Promise<boolean> {
  return serverSupports(runtime, server, ORCHESTRATION_REMOTE_OWNED_WORKERS_RUNTIME_CAPABILITY)
}

export async function forwardedChatLineage(
  runtime: OrcaRuntimeService,
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>,
  params: StartParams,
  caller: Parameters<typeof startsInChatLineage>[3],
  server: OrchestrationWorkerServer
): Promise<{ chatLineage?: true }> {
  return startsInChatLineage(runtime, db, params, caller) &&
    (await serverSupports(runtime, server, ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY))
    ? { chatLineage: true }
    : {}
}

export async function forwardedBotLineage(
  botLineage: boolean,
  runtime: OrcaRuntimeService,
  server: OrchestrationWorkerServer
): Promise<{ botLineage?: true }> {
  return botLineage &&
    (await serverSupports(runtime, server, ORCHESTRATION_BOT_LINEAGE_RUNTIME_CAPABILITY))
    ? { botLineage: true }
    : {}
}

export function serverStartOptions(params: WorkerStartInput) {
  const {
    from: _from,
    run: _run,
    on: _on,
    task: _task,
    deps: _deps,
    parent: _parent,
    chatLineage: _chatLineage,
    botLineage: _botLineage,
    inheritedLaunchPreferences: _inheritedLaunchPreferences,
    ...options
  } = params
  return options
}
