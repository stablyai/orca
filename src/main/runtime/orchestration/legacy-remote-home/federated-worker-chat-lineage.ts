import { ORCHESTRATION_BOT_LINEAGE_RUNTIME_CAPABILITY } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RpcContext } from '../../rpc/core'
import { startsInBotLineage } from '../../rpc/methods/orchestration/worker/start/worker-chat-lineage'
import type { OrchestrationDb } from '../db/orchestration-db'

type AuthenticatedRuntimeTransport = Pick<
  RpcContext,
  'clientKind' | 'pairedDeviceId' | 'authenticatedCallerFingerprint'
>

export function forwardedFederatedBotLineage(
  botLineage: boolean,
  capabilities: readonly string[] | undefined
): { botLineage?: true } {
  return botLineage && capabilities?.includes(ORCHESTRATION_BOT_LINEAGE_RUNTIME_CAPABILITY)
    ? { botLineage: true }
    : {}
}

/** Includes direct bot-home starts plus retry and helper inheritance before the remote row exists. */
export function federatedWorkerBotLineage(
  runtime: Parameters<typeof startsInBotLineage>[0],
  db: OrchestrationDb,
  params: Parameters<typeof startsInBotLineage>[2],
  caller: Parameters<typeof startsInBotLineage>[3],
  followUpOf?: string
): boolean {
  return startsInBotLineage(runtime, db, params, caller, followUpOf)
}

/** Only the paired runtime transport, not a local mutation receipt, may stamp remote bot lineage. */
export function federatedAttachmentBotLineage(
  botLineage: true | undefined,
  transport: AuthenticatedRuntimeTransport
): boolean {
  return (
    botLineage === true &&
    transport.clientKind === 'runtime' &&
    transport.pairedDeviceId !== undefined &&
    Boolean(transport.authenticatedCallerFingerprint)
  )
}
