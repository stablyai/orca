// `orca bot slack intro [--off]`: says whether a bot posts an intro in a Slack channel a person adds
// it to, or turns that off. Off only makes the bot quieter, so a CLI may do it; on is a switch in the
// owner's Orca (bots.update, owner only), never a CLI's.
import {
  BOT_SLACK_CHANNEL_HELLO_SET_METHOD,
  BotSlackChannelHelloSet,
  type BotSlackChannelHelloSetParams
} from '../../../../shared/rpc-contract/bots-slack-channel-hello-params'
import { CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE } from '../../../../shared/connector-cloud-features'
import type { Bot } from '../../../../shared/bot-types'
import { writeInChat } from '../../../bots/bot-chat-status-line'
import { BOT_TOKEN_ENDED, botOfToken } from '../../../bots/bot-of-caller'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { botTurnFor } from '../../../bots/bot-turn-for'
import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'

type CloudTakes = 'yes' | 'no' | 'not_connected'

/** The bot the command came from (its chat, its look, or its run's token); null for the owner's own
 *  terminal or another agent's. */
function callingBot(
  params: BotSlackChannelHelloSetParams,
  context: RpcContext,
  caller: string | undefined,
  lookBotId: string | null
): Bot | null {
  const { runtime } = context
  const byToken = botOfToken(runtime, params.botToken, context.pairedDeviceId)
  if (byToken.kind === 'ended') {
    throw new InvalidArgumentError(BOT_TOKEN_ENDED)
  }
  const bySession = lookBotId
    ? (runtime.bots.list().find((bot) => bot.id === lookBotId) ?? null)
    : caller
      ? botOfSession(runtime.bots, caller)
      : null
  if (byToken.kind === 'bot' && bySession && bySession.id !== byToken.bot.id) {
    throw new InvalidArgumentError('A bot can change only its own Slack intro.')
  }
  return byToken.kind === 'bot' ? byToken.bot : bySession
}

/** Why Orca Cloud doesn't act on the switch here yet; null where it does. */
function notApplied(bot: Bot, cloud: CloudTakes): string | null {
  return cloud === 'not_connected'
    ? `${bot.name}’s Orca isn’t connected to Orca Cloud right now, so Orca Cloud may still post its Slack intro.`
    : cloud === 'no'
      ? `Orca Cloud doesn’t take this switch yet, so ${bot.name} still posts an intro when added to a Slack channel.`
      : null
}

/** What is saved, and whether Orca Cloud acts on it: only a live cloud that takes the switch does. */
function stateOf(bot: Bot, cloud: CloudTakes) {
  const on = bot.slackChannelHello !== false
  const why = notApplied(bot, cloud)
  const change = why
    ? `${why} Saved setting: ${on ? 'on' : 'off'}.`
    : on
      ? `${bot.name} posts an intro when added to a Slack channel.`
      : `${bot.name} is set not to post an intro when added to a Slack channel.`
  return {
    bot: { id: bot.id, name: bot.name },
    slackChannelHello: on,
    cloud,
    applied: why === null,
    change
  }
}

async function setSlackChannelHello(params: BotSlackChannelHelloSetParams, context: RpcContext) {
  const { runtime } = context
  runtime.bots.assertEnabled()
  // The session the host verified wins over the one the command names; a paired client's claim
  // names no chat here.
  const verified = sessionCallerOf(context.orchestrationCaller)?.sessionId
  const caller =
    verified ?? (context.pairedDeviceId === undefined ? params.callerSessionId : undefined)
  const lookBotId = caller ? runtime.lookAround.botOfLook(caller) : null
  if (lookBotId && params.off) {
    throw new InvalidArgumentError('Looking around can only read.')
  }
  const callerBot = callingBot(params, context, caller, lookBotId)
  const bot = params.botId
    ? runtime.bots.list().find((entry) => entry.id === params.botId)
    : callerBot
  if (!bot) {
    throw new InvalidArgumentError(
      params.botId ? 'bot_not_found' : 'Name the bot with --bot, or run this from the bot’s chat.'
    )
  }
  if (callerBot && callerBot.id !== bot.id) {
    throw new InvalidArgumentError('A bot can change only its own Slack intro.')
  }
  // Only a cloud the connector reaches now applies it; a cached answer from before a halt, a refused
  // sign-in or an outage doesn't.
  const features = runtime.getConnectorCloud()?.liveCloudFeatures() ?? null
  const cloud: CloudTakes =
    features === null
      ? 'not_connected'
      : features.has(CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE)
        ? 'yes'
        : 'no'
  if (!params.off) {
    return stateOf(bot, cloud)
  }
  const why = notApplied(bot, cloud)
  if (why) {
    throw new InvalidArgumentError(`${why} Nothing was changed.`)
  }
  // From a bot's chat or run, only a turn its owner asked for may change the owner's setting, as the
  // host verified it: a bot's command without that evidence (an older CLI, a WSL chat, a raw call)
  // changes nothing.
  if (callerBot) {
    const turnFor = verified ? await botTurnFor(runtime, verified, verified) : 'none'
    if (turnFor !== 'owner') {
      throw new InvalidArgumentError(
        'Only your owner can turn off your Slack intro. Ask them to, or to do it in Orca.'
      )
    }
  }
  if (bot.slackChannelHello === false) {
    return { ...stateOf(bot, cloud), change: `${bot.name}’s Slack intro was already off.` }
  }
  // Inside the update queue, so an owner's edit in Settings made meanwhile is not undone.
  const saved = await runtime.bots.update(bot.id, () => ({ slackChannelHello: false }))
  const change = `Saved: ${saved.name} is set not to post an intro when added to a Slack channel.`
  // The owner sees it in the bot's own chat: the one that ran it, or else its Home Chat.
  writeInChat(
    callerBot ? caller : (saved.chatSessionId ?? undefined),
    { kind: 'status', text: change },
    'slack-intro'
  )
  return { ...stateOf(saved, cloud), change }
}

export const BOT_SLACK_CHANNEL_HELLO_METHODS = [
  defineMethod({
    name: BOT_SLACK_CHANNEL_HELLO_SET_METHOD,
    permission: 'workspace',
    params: BotSlackChannelHelloSet,
    handler: setSlackChannelHello
  })
]
