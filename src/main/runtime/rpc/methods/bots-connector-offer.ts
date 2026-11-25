// `orca bot connectors --offer`: a bot that needs Slack, Linear, GitHub or Google asks Orca to put a
// Connect card in its chat, instead of telling its owner where to click. Teams gets a line instead.
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
import type { AgentJournalPlainStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { BotConnectorOffer } from '../../../../shared/rpc-contract/bots-look-around-params'
import { teamsOfferLine, teamsOfferReply } from '../../../../shared/teams/teams-bot-offer'
import { getTeamsConnect } from '../../../teams/teams-connect'
import { hostGoogleBotState } from '../../../bots/bot-google-access'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { LOOK_AROUND_REFUSAL } from '../../../bots/bot-look-around-policy'
import { refuseBotGroupRoomCard } from '../../../bots/bot-group-session-access'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, InvalidArgumentError } from '../core'
import { orcaSignInServer } from '../../../bots/orca-sign-in-server'

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

async function postInAskingChat(
  callerSessionId: string,
  body: AgentJournalPlainStatusItem
): Promise<void> {
  refuseBotGroupRoomCard(callerSessionId)
  const host = getStructuredAgentSessionHost()
  // Null for a session this host doesn't run.
  const destination = await host?.captureAgentStartDestination(callerSessionId)
  if (!host || !destination) {
    throw new InvalidArgumentError('Run this from your chat in Orca.')
  }
  await host.appendAgentStart(
    destination,
    { body, messageId: `connector-offer:${randomUUID()}` },
    Date.now()
  )
}

/** Puts the Connect card in the asking chat. */
export async function postConnectorOffer(
  callerSessionId: string,
  bot: Pick<Bot, 'name'>,
  offer: ConnectorOffer,
  runtime: Pick<OrcaRuntimeService, 'servesWithoutWindow'>
): Promise<void> {
  await postInAskingChat(
    callerSessionId,
    connectorOfferBody(offer, bot.name, orcaSignInServer(runtime))
  )
}

export const BOT_CONNECTOR_OFFER_METHOD = defineMethod({
  name: 'bots.connector.offer',
  permission: 'workspace',
  params: BotConnectorOffer,
  handler: async ({ callerSessionId, source, workspace }, { runtime, pairedDeviceId }) => {
    runtime.bots.assertEnabled()
    const bot = offeringBot(runtime, callerSessionId, pairedDeviceId)
    if (source === 'teams') {
      const account = await getTeamsConnect().account()
      const state = { account, botOn: bot.teams === true }
      const line = teamsOfferLine(state, bot.name)
      if (line) {
        await postInAskingChat(callerSessionId, { kind: 'status', text: line })
      }
      return teamsOfferReply(state, bot.name)
    }
    const signIn = signInOfferReply(
      bot,
      source,
      runtime.getConnectorCloud()?.status(),
      orcaSignInServer(runtime)
    )
    if (signIn) {
      if (signIn.offered) {
        await postConnectorOffer(
          callerSessionId,
          bot,
          { botId: bot.id, source, signIn: true },
          runtime
        )
      }
      return signIn
    }
    if (source === 'webhook') {
      throw new InvalidArgumentError('Webhooks are offered only as Sign in.')
    }
    const answer: ReturnType<typeof connectorOfferReply> =
      source === 'google'
        ? googleOfferReply(await hostGoogleBotState(bot), {
            headless: noWindowAnswersGoogleCards(runtime),
            botName: bot.name
          })
        : connectorOfferReply(bot, source, workspace)
    const { addAccess, ...reply } = answer
    if (reply.offered) {
      await postConnectorOffer(
        callerSessionId,
        bot,
        {
          botId: bot.id,
          source,
          ...(workspace ? { workspace } : {}),
          ...(addAccess ? { addAccess } : {})
        },
        runtime
      )
    }
    return reply
  }
})
