import { ORCHESTRATION_FEDERATION_CHAT_LINEAGE_RUNTIME_CAPABILITY } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { startsInChatLineage } from '../../rpc/methods/orchestration/worker/start/worker-chat-lineage'
import type { OrchestrationDb } from '../db/orchestration-db'

export function forwardedFederatedChatLineage(
  chatLineage: boolean,
  capabilities: readonly string[] | undefined
): { chatLineage?: true } {
  return chatLineage &&
    capabilities?.includes(ORCHESTRATION_FEDERATION_CHAT_LINEAGE_RUNTIME_CAPABILITY)
    ? { chatLineage: true }
    : {}
}

/** Includes direct bot-home starts plus retry and helper inheritance before the remote row exists. */
export function federatedWorkerChatLineage(
  runtime: Parameters<typeof startsInChatLineage>[0],
  db: OrchestrationDb,
  params: Parameters<typeof startsInChatLineage>[2],
  caller: Parameters<typeof startsInChatLineage>[3]
): boolean {
  return startsInChatLineage(runtime, db, params, caller)
}

/** The legacy attach's mutation identity is authenticated by its paired runtime transport. */
export function federatedAttachmentChatLineage(
  chatLineage: true | undefined,
  authenticatedMutation: boolean
): boolean {
  return authenticatedMutation && chatLineage === true
}
