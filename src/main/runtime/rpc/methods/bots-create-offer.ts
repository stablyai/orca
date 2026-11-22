// `orca bot create --offer`: a bot, or an agent in the owner's own chat, proposes a new bot, and Orca
// puts a card in that chat. Nothing is created until the owner presses Create bot on it.
import { randomUUID } from 'node:crypto'
import { isBotAgent, type BotAgent } from '../../../../shared/bot-types'
import { parseBotAvatar, randomMascotAvatar } from '../../../../shared/bot-avatar'
import { botCreateOfferBody } from '../../../../shared/bots/bot-proposal'
import { BotCreateOfferRequest } from '../../../../shared/rpc-contract/bots-params'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { LOOK_AROUND_REFUSAL } from '../../../bots/bot-look-around-policy'
import { refuseBotGroupRoomCard } from '../../../bots/bot-group-session-access'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defineMethod, InvalidArgumentError } from '../core'

// Partial test hosts may omit deps, as botOfSession allows.
type ChatLookup = {
  deps?: { store: { getConversation: (id: string) => { provider: string } | null | undefined } }
}

/** The agent a chat runs on, when a bot can run on it too. */
function chatAgentOf(host: ChatLookup, sessionId: string): BotAgent | undefined {
  const provider = host.deps?.store.getConversation(sessionId)?.provider
  return provider && isBotAgent(provider) ? provider : undefined
}

export const BOT_CREATE_OFFER_METHOD = defineMethod({
  name: 'bots.createOffer',
  permission: 'workspace',
  params: BotCreateOfferRequest,
  handler: async ({ callerSessionId, ...proposal }, { runtime, pairedDeviceId }) => {
    runtime.bots.assertEnabled()
    // A session id names a chat only on its own host.
    if (pairedDeviceId !== undefined) {
      throw new InvalidArgumentError('Run this from a chat in Orca.')
    }
    // Null in the owner's own chat: the card still only proposes, and the owner creates the bot.
    const bot = botOfSession(runtime.bots, callerSessionId)
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
    refuseBotGroupRoomCard(callerSessionId)
    const host = getStructuredAgentSessionHost()
    // Null for a session this host doesn't run.
    const destination = await host?.captureAgentStartDestination(callerSessionId)
    if (!host || !destination) {
      throw new InvalidArgumentError('Run this from your chat in Orca.')
    }
    const chatAgent = bot ? undefined : chatAgentOf(host, callerSessionId)
    const mascot = parseBotAvatar(randomMascotAvatar(null))
    const offeredAt = Date.now()
    const offerId = randomUUID()
    await host.appendAgentStart(
      destination,
      {
        body: botCreateOfferBody(
          {
            ...(bot ? { botId: bot.id } : chatAgent ? { agent: chatAgent } : {}),
            offerId,
            proposal: { ...proposal, ...(mascot?.kind === 'mascot' ? { mascot: mascot.id } : {}) },
            offeredAt
          },
          bot?.name ?? null
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
