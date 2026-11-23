// `orca bot create --offer`: a bot proposes a new bot, and Orca puts a card in its chat. Nothing is
// created until the owner presses Create bot on it.
import { randomUUID } from 'node:crypto'
import { parseBotAvatar, randomMascotAvatar } from '../../../../shared/bot-avatar'
import { botCreateOfferBody } from '../../../../shared/bots/bot-proposal'
import { BotCreateOfferRequest } from '../../../../shared/rpc-contract/bots-params'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { LOOK_AROUND_REFUSAL } from '../../../bots/bot-look-around-policy'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defineMethod, InvalidArgumentError } from '../core'

export const BOT_CREATE_OFFER_METHOD = defineMethod({
  name: 'bots.createOffer',
  permission: 'workspace',
  params: BotCreateOfferRequest,
  handler: async ({ callerSessionId, ...proposal }, { runtime, pairedDeviceId }) => {
    runtime.bots.assertEnabled()
    // A session id names a chat only on its own host.
    const bot = pairedDeviceId === undefined ? botOfSession(runtime.bots, callerSessionId) : null
    if (!bot) {
      throw new InvalidArgumentError("Run this from a bot's chat.")
    }
    if (runtime.lookAround.botOfLook(callerSessionId)) {
      throw new InvalidArgumentError(LOOK_AROUND_REFUSAL)
    }
    const wanted = proposal.name.toLowerCase()
    if (runtime.bots.list().some((entry) => entry.name.toLowerCase() === wanted)) {
      return {
        offered: false,
        message: `Your owner already has a bot named ${proposal.name}; no card was shown. Pick another name.`
      }
    }
    const host = getStructuredAgentSessionHost()
    // Null for a session this host doesn't run.
    const destination = await host?.captureAgentStartDestination(callerSessionId)
    if (!host || !destination) {
      throw new InvalidArgumentError('Run this from your chat in Orca.')
    }
    const mascot = parseBotAvatar(randomMascotAvatar(null))
    const offeredAt = Date.now()
    const offerId = randomUUID()
    await host.appendAgentStart(
      destination,
      {
        body: botCreateOfferBody(
          {
            botId: bot.id,
            offerId,
            proposal: { ...proposal, ...(mascot?.kind === 'mascot' ? { mascot: mascot.id } : {}) },
            offeredAt
          },
          bot.name
        ),
        messageId: `bot-create-offer:${offerId}`
      },
      offeredAt
    )
    return {
      offered: true,
      message: `Your owner now sees a card proposing ${proposal.name}. Nothing is created until they press Create bot; if they create it, it starts with this purpose in its SOUL.md${proposal.worktrees?.length ? ' and takes over those workspaces' : ''}. A "Dismiss" comes back as a message.`
    }
  }
})
