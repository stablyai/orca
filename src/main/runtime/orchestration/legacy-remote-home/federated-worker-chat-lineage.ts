import { ORCHESTRATION_FEDERATION_CHAT_LINEAGE_RUNTIME_CAPABILITY } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RpcContext } from '../../rpc/core'
import { startsInBotLineage } from '../../rpc/methods/orchestration/worker/start/worker-chat-lineage'
import type { OrchestrationDb } from '../db/orchestration-db'

type AuthenticatedRuntimeTransport = Pick<
  RpcContext,
  'clientKind' | 'pairedDeviceId' | 'authenticatedCallerFingerprint'
>

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
  return startsInBotLineage(runtime, db, params, caller)
}

/** Only the paired runtime transport, not a local mutation receipt, may stamp remote bot lineage. */
export function federatedAttachmentChatLineage(
  chatLineage: true | undefined,
  transport: AuthenticatedRuntimeTransport
): boolean {
  return (
    chatLineage === true &&
    transport.clientKind === 'runtime' &&
    transport.pairedDeviceId !== undefined &&
    Boolean(transport.authenticatedCallerFingerprint)
  )
}
