import type {
  ConnectorConversation,
  ConnectorDeliveryResult
} from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import type { TurnAutomations } from './connector-turn-automations'

export async function recordedInTurn(
  seam: ExternalConversationSeam,
  key: ConnectorConversation,
  done: Promise<ConnectorDeliveryResult>,
  automations: () => TurnAutomations | null
): Promise<ConnectorDeliveryResult> {
  const result = await done
  if (result.outcome !== 'accepted' || result.muted || result.inTurn) {
    return result
  }
  try {
    const inTurn = automations()
    if (!inTurn) {
      return result
    }
    await inTurn.record(seam.linkedChat(key))
  } catch (error) {
    console.warn('[connectors] could not record the automations a turn ran', error)
    return result
  }
  return { ...result, inTurn: true }
}
