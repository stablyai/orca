import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'

export const ORCHESTRATION_CROSS_PLANE_ACK_HANDLER: Record<string, CommandHandler> = {
  'orchestration ack-verify': async ({ flags, client, json }) => {
    const result = await client.call<{
      state: 'accepted' | 'prompt_delivered' | 'completion_verified'
      verified: boolean
      effectsApplied: false
      missing: string[]
    }>('orchestration.crossPlaneVerify', {
      messageId: getRequiredStringFlag(flags, 'message-id'),
      ackMessageId: getOptionalStringFlag(flags, 'ack-message-id'),
      completionReceiptId: getOptionalStringFlag(flags, 'completion-receipt-id'),
      correlationId: getRequiredStringFlag(flags, 'correlation-id'),
      senderEpoch: getRequiredStringFlag(flags, 'sender-epoch'),
      receiverEpoch: getRequiredStringFlag(flags, 'receiver-epoch'),
      dispatchId: getOptionalStringFlag(flags, 'dispatch-id'),
      orcaIdentity: getRequiredStringFlag(flags, 'orca-identity'),
      externalPlane: getRequiredStringFlag(flags, 'external-plane'),
      externalIdentity: getRequiredStringFlag(flags, 'external-identity'),
      linkEvidenceId: getRequiredStringFlag(flags, 'link-evidence-id')
    })
    printResult(result, json, (value) => {
      const suffix = value.missing.length > 0 ? ` missing=${value.missing.join(',')}` : ''
      return `${value.state} verified=${value.verified}${suffix}`
    })
  }
}
