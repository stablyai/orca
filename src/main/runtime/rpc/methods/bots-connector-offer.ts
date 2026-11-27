// `orca bot connectors --offer`: a bot that needs Slack, Linear, GitHub or Google asks Orca to put a
// Connect card in its chat, instead of telling its owner where to click.
import { noWindowAnswersGoogleCards } from '../../../google/google-card-reach'
import { randomUUID } from 'node:crypto'
import type { Bot } from '../../../../shared/bot-types'
import {
  connectorOfferBody,
  connectorOfferReply,
  googleOfferReply,
  signInOfferReply,
  type ConnectorOffer
} from '../../../../shared/bots/bot-connector-offer'
import { BotConnectorOffer } from '../../../../shared/rpc-contract/bots-look-around-params'
import { hostGoogleBotState } from '../../../bots/bot-google-access'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { LOOK_AROUND_REFUSAL } from '../../../bots/bot-look-around-policy'
import { refuseBotGroupRoomCard } from '../../../bots/bot-group-session-access'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, InvalidArgumentError } from '../core'
import { orcaSignInServer } from '../../../bots/orca-sign-in-server'
import {
  connectorOfferThreadNote,
  type ConnectorOfferCardKind
} from '../../../../shared/bots/bot-connector-offer-thread-note'
import { findLinksForSession } from '../../../external-conversations/external-conversation-links'
import { runtimeChatHost } from '../../../external-conversations/external-conversation-chat'
import { CONNECTOR_OFFER_NO_DIRECTIONS } from '../../../../shared/bots/connector-offer-directions'

/** The bot whose own chat on this host asks; never one a paired device or a Look around names. */
function offeringBot(
  runtime: OrcaRuntimeService,
  callerSessionId: string,
  pairedDeviceId: string | undefined
): Bot {
  // A session id names a chat only on its own host.
  const bot = pairedDeviceId === undefined ? botOfSession(runtime.bots, callerSessionId) : null
  if (!bot) {
    throw new InvalidArgumentError("Run this from a bot's chat.")
  }
  if (runtime.lookAround.botOfLook(callerSessionId)) {
    throw new InvalidArgumentError(LOOK_AROUND_REFUSAL)
  }
  return bot
}

/** Puts the Connect card in the asking chat; false when the chat changed before it was written. */
export async function postConnectorOffer(
  callerSessionId: string,
  bot: Pick<Bot, 'name'>,
  offer: ConnectorOffer,
  runtime: Pick<OrcaRuntimeService, 'servesWithoutWindow'>
): Promise<boolean> {
  refuseBotGroupRoomCard(callerSessionId)
  const host = getStructuredAgentSessionHost()
  // Null for a session this host doesn't run.
  const destination = await host?.captureAgentStartDestination(callerSessionId)
  if (!host || !destination) {
    throw new InvalidArgumentError('Run this from your chat in Orca.')
  }
  return host.appendAgentStart(
    destination,
    {
      body: connectorOfferBody(offer, bot.name, orcaSignInServer(runtime)),
      messageId: `connector-offer:${randomUUID()}`
    },
    Date.now()
  )
}

export const CONNECTOR_OFFER_NOT_SHOWN =
  'No card was shown: this chat changed while Orca was adding it. Run the same command again.'

/**
 * Posts the card and answers for it: when its chat answers a Slack, Linear or GitHub thread, the
 * answer says the card is only in Orca and gives the line that sends the owner to it.
 */
export async function offerConnectorCard(
  runtime: Pick<
    OrcaRuntimeService,
    | 'servesWithoutWindow'
    | 'requireStore'
    | 'getExternalConversationSeam'
    | 'ensureStructuredAgentSessionHost'
  >,
  callerSessionId: string,
  bot: Pick<Bot, 'id' | 'name'>,
  offer: ConnectorOffer,
  message: string,
  kind: ConnectorOfferCardKind = {}
): Promise<{ shown: boolean; message: string }> {
  if (!(await postConnectorOffer(callerSessionId, bot, offer, runtime))) {
    return { shown: false, message: CONNECTOR_OFFER_NOT_SHOWN }
  }
  const note = connectorOfferThreadNote(
    bot.id,
    answeredThread(runtime, callerSessionId, bot),
    offer,
    kind
  )
  return {
    shown: true,
    message: note ? `${message.replace(CONNECTOR_OFFER_NO_DIRECTIONS, '')} ${note}` : message
  }
}

/** The bot's thread this turn answers, as its workers' reports go there; null for a turn in Orca. */
function answeredThread(
  runtime: Pick<
    OrcaRuntimeService,
    'requireStore' | 'getExternalConversationSeam' | 'ensureStructuredAgentSessionHost'
  >,
  sessionId: string,
  bot: Pick<Bot, 'id'>
) {
  try {
    const seam = runtime.getExternalConversationSeam()
    if (!seam?.conversationTurn(runtimeChatHost(runtime), sessionId)) {
      return null
    }
    return (
      findLinksForSession(runtime.requireStore(), sessionId).find(
        (entry) => entry.link.bot?.botId === bot.id
      )?.link ?? null
    )
  } catch {
    // No store yet: the card is posted, so answer without the note rather than fail the offer.
    return null
  }
}

export const BOT_CONNECTOR_OFFER_METHOD = defineMethod({
  name: 'bots.connector.offer',
  permission: 'workspace',
  params: BotConnectorOffer,
  handler: async ({ callerSessionId, source, workspace }, { runtime, pairedDeviceId }) => {
    runtime.bots.assertEnabled()
    const bot = offeringBot(runtime, callerSessionId, pairedDeviceId)
    const signIn = signInOfferReply(
      bot,
      source,
      runtime.getConnectorCloud()?.status(),
      orcaSignInServer(runtime)
    )
    if (signIn) {
      if (signIn.offered) {
        const card = await offerConnectorCard(
          runtime,
          callerSessionId,
          bot,
          { botId: bot.id, source, signIn: true },
          signIn.message
        )
        return { offered: card.shown, message: card.message }
      }
      return signIn
    }
    if (source === 'webhook') {
      throw new InvalidArgumentError('Webhooks are offered only as Sign in.')
    }
    let answer: ReturnType<typeof connectorOfferReply>
    let kind: ConnectorOfferCardKind = {}
    if (source === 'google') {
      const google = await hostGoogleBotState(bot)
      answer = googleOfferReply(google, {
        headless: noWindowAnswersGoogleCards(runtime),
        botName: bot.name
      })
      // Google already on: its Connected card adds another account (googleBotAsk).
      kind = { googleAnotherAccount: google.allowed && google.host === 'connected' }
    } else {
      answer = connectorOfferReply(bot, source, workspace)
    }
    const { addAccess, ...reply } = answer
    if (reply.offered) {
      const card = await offerConnectorCard(
        runtime,
        callerSessionId,
        bot,
        {
          botId: bot.id,
          source,
          ...(workspace ? { workspace } : {}),
          ...(addAccess ? { addAccess } : {})
        },
        reply.message,
        kind
      )
      return { offered: card.shown, message: card.message }
    }
    return reply
  }
})
