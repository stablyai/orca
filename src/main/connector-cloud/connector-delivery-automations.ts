import type {
  ConnectorConversation,
  ConnectorDeliveryResult
} from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import type { TurnAutomations } from './connector-turn-automations'

export async function recordedInTurn(
  seam: ExternalConversationSeam,
  key: ConnectorConversation,
  inTurn: TurnAutomations | null,
  done: Promise<ConnectorDeliveryResult>
): Promise<ConnectorDeliveryResult> {
  const result = await done
  if (!inTurn || result.outcome !== 'accepted') {
    return result
  }
  try {
    await inTurn.record(seam.linkedChat(key))
  } catch (error) {
    console.warn('[connectors] could not record the automations a turn ran', error)
    return result
  }
  return { ...result, inTurn: true }
}
