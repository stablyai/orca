// `orca bot group create --offer`: a bot proposes a group chat, and Orca puts a card in its chat.
// Nothing is created until the owner presses Create group on it.
import { randomUUID } from 'node:crypto'
import {
  BOT_GROUP_OFFER_MAX_MEMBERS,
  BotGroupOfferRequest,
  botGroupOfferBody
} from '../../../../shared/bots/bot-group-offer'
import { runtimeBotGroups } from '../../../bots/bot-group-runtime'
import { requireGroupBots } from '../../../bots/bot-group-membership'
import { refuseBotGroupRoomCard } from '../../../bots/bot-group-session-access'
import { LOOK_AROUND_REFUSAL } from '../../../bots/bot-look-around-policy'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defineMethod, InvalidArgumentError } from '../core'

export const BOT_GROUP_CREATE_OFFER_METHOD = defineMethod({
  name: 'bots.groups.createOffer',
  permission: 'workspace',
  params: BotGroupOfferRequest,
  handler: async (
    { callerSessionId, name, purpose, botIds, withoutCaller },
    { runtime, pairedDeviceId }
  ) => {
    runtime.bots.assertEnabled()
    // A session id names a chat only on its own host.
    const bot = pairedDeviceId === undefined ? botOfSession(runtime.bots, callerSessionId) : null
    if (!bot) {
      throw new InvalidArgumentError("Run this from a bot's chat.")
    }
    if (runtime.lookAround.botOfLook(callerSessionId)) {
      throw new InvalidArgumentError(LOOK_AROUND_REFUSAL)
    }
    refuseBotGroupRoomCard(callerSessionId)
    const others = botIds.filter((id) => id !== bot.id)
    const wanted = withoutCaller ? others : [bot.id, ...others]
    if (wanted.length > BOT_GROUP_OFFER_MAX_MEMBERS) {
      throw new InvalidArgumentError(
        `A group offer can have at most ${BOT_GROUP_OFFER_MAX_MEMBERS} bots, including yourself.`
      )
    }
    if (wanted.length === 0) {
      throw new InvalidArgumentError(
        'Name the bots for the group with --bot <name>, as `orca bot list` shows them.'
      )
    }
    const members = requireGroupBots(runtimeBotGroups(runtime), wanted).map((member) => ({
      botId: member.id,
      name: member.name
    }))
    const host = getStructuredAgentSessionHost()
    // Null for a session this host doesn't run.
    const destination = await host?.captureAgentStartDestination(callerSessionId)
    if (!host || !destination) {
      throw new InvalidArgumentError('Run this from your chat in Orca.')
    }
    const offeredAt = Date.now()
    const offerId = randomUUID()
    await host.appendAgentStart(
      destination,
      {
        body: botGroupOfferBody(
          { botId: bot.id, offerId, name, members, ...(purpose ? { purpose } : {}), offeredAt },
          bot.name
        ),
        messageId: `bot-group-offer:${offerId}`
      },
      offeredAt
    )
    return {
      offered: true,
      message: `Your owner now sees a card proposing the group ${name} with ${members.map((member) => member.name).join(', ')}. Nothing is created until they press Create group; ${members[0].name} answers there by default. A "Dismiss" comes back as a message.`
    }
  }
})
