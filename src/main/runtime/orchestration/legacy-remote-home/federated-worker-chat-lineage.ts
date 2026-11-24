import { ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY } from '../../../../shared/orchestration/orchestration-runtime-capabilities'

export function forwardedFederatedChatLineage(
  chatLineage: boolean,
  capabilities: readonly string[] | undefined
): { chatLineage?: true } {
  return chatLineage && capabilities?.includes(ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY)
    ? { chatLineage: true }
    : {}
}
