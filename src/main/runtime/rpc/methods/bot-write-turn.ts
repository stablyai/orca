import type { BotWriteTurn } from '../../../bots/bot-owner-writes'
import { botOfSession } from '../../../bots/bot-session-tabs'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { readBotTurn } from './orchestration/messaging/bot-recipient'

/** The calling bot's turn, for a write it makes as its owner; null outside a bot's chat. A session id
 *  names a chat only on its own host, so a paired client's names none. */
export async function readBotWriteTurn(
  runtime: OrcaRuntimeService,
  callerSessionId: string | undefined,
  pairedDeviceId: string | undefined
): Promise<BotWriteTurn | null> {
  if (!callerSessionId || pairedDeviceId !== undefined || !runtime.bots.enabled()) {
    return null
  }
  const bot = botOfSession(runtime.bots, callerSessionId)
  if (!bot) {
    return null
  }
  const { turn, conversation } = await readBotTurn(
    runtime,
    runtime.getOrchestrationDb(),
    callerSessionId
  )
  return { bot, turn, inConversation: conversation !== null }
}
