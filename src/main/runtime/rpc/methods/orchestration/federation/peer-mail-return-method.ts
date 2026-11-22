import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import {
  PeerMailRelayPayload,
  PeerMailReturnParams
} from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { isClientEnvironment } from '../../../../orchestration/federation/client-asks/client-ask-environment'
import { storePeerReply } from '../../../../orchestration/federation/peer-mail/peer-reply-store'
import { requireRuntimePairing } from './peer-mail-methods'

/** A paired computer hands back the replies and notices its agents owe asks from this Orca's agents,
 *  in the pull's item shape; it acknowledges on its side exactly what this answers as taken. */
export const ORCHESTRATION_PEER_MAIL_RETURN_METHOD = defineOrchestrationMethod({
  name: 'orchestration.peerMailReturn',
  access: { kind: 'localOnly', targets: {} },
  permission: 'workspace',
  params: PeerMailReturnParams,
  handler: (params, ctx) => {
    const peerFingerprint = requireRuntimePairing(ctx)
    const { runtime } = ctx
    const db = runtime.getOrchestrationDb()
    const through = new Map<string, number>()
    const gone = new Set<string>()
    for (const item of params.items) {
      const conversation = db.getPeerMailConversation(item.conversationId)
      // Only this Orca's conversation with that computer, under the pairing it calls with now.
      if (
        conversation?.role !== 'home' ||
        !isClientEnvironment(conversation.environment_id) ||
        conversation.peer_fingerprint !== peerFingerprint
      ) {
        gone.add(item.conversationId)
        continue
      }
      const payload = PeerMailRelayPayload.safeParse(safeJson(item.payload))
      if (payload.success) {
        const stored = storePeerReply(runtime, db, conversation, item.messageId, payload.data)
        if (stored) {
          runtime.notifyMessageArrived(stored.to_handle, stored.type)
        }
      } else {
        console.warn(
          `[orchestration] Dropped an unreadable reply ${item.messageId} from a paired computer`
        )
      }
      through.set(
        item.conversationId,
        Math.max(through.get(item.conversationId) ?? 0, item.sequence)
      )
    }
    return {
      acknowledgments: [...through].map(([conversationId, throughSequence]) => ({
        conversationId,
        throughSequence
      })),
      gone: [...gone]
    }
  }
})

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
