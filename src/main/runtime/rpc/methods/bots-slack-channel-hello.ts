// `orca bot slack intro [--off]`: says whether a bot posts an intro in a Slack channel a person adds
// it to, or turns that off. Off only makes the bot quieter, so a CLI may do it; on is a switch in the
// owner's Orca (bots.update, owner only), never a CLI's.
import {
  BotSlackChannelHelloSet,
  type BotSlackChannelHelloSetParams
} from '../../../../shared/rpc-contract/bots-slack-channel-hello-params'
import { CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE } from '../../../../shared/connector-cloud-features'
import type { Bot } from '../../../../shared/bot-types'
import { noteInChat } from '../../../bots/bot-chat-status-line'
import { BOT_TOKEN_ENDED, botOfToken } from '../../../bots/bot-of-caller'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { botTurnFor } from '../../../bots/bot-turn-for'
import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'

type CloudTakes = 'yes' | 'no' | 'not_connected'

/** The bot the command came from (its chat, or its run's token), else null for the owner's own terminal. */
function callingBot(params: BotSlackChannelHelloSetParams, context: RpcContext, caller?: string) {
  const { runtime } = context
  const byToken = botOfToken(runtime, params.botToken, context.pairedDeviceId)
  if (byToken.kind === 'ended') {
    throw new InvalidArgumentError(BOT_TOKEN_ENDED)
  }
  const bySession = caller ? botOfSession(runtime.bots, caller) : null
  if (byToken.kind === 'bot' && bySession && bySession.id !== byToken.bot.id) {
    throw new InvalidArgumentError('A bot can change only its own Slack intro.')
  }
  return byToken.kind === 'bot' ? byToken.bot : bySession
}

function stateOf(bot: Bot, cloud: CloudTakes) {
  const on = bot.slackChannelHello !== false
  const change =
    cloud === 'not_connected'
      ? `${bot.name}’s Orca isn’t connected to Orca Cloud, so whether it posts an intro can’t be told here.`
      : cloud === 'no'
        ? `${bot.name} posts an intro when added to a Slack channel: Orca Cloud doesn’t take the switch yet.`
        : on
          ? `${bot.name} posts an intro when added to a Slack channel.`
          : `${bot.name} doesn’t post an intro when added to a Slack channel.`
  return { bot: { id: bot.id, name: bot.name }, slackChannelHello: on, cloud, change }
}

async function setSlackChannelHello(params: BotSlackChannelHelloSetParams, context: RpcContext) {
  const { runtime } = context
  runtime.bots.assertEnabled()
  // A session id names a chat only on its own host, so a paired client's claim names none.
  const caller = context.pairedDeviceId === undefined ? params.callerSessionId : undefined
  // A look itself only reads; its session would otherwise read as its bot's.
  if (caller && runtime.lookAround.botOfLook(caller)) {
    throw new InvalidArgumentError('Looking around can only read.')
  }
  const callerBot = callingBot(params, context, caller)
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
  const features = runtime.getConnectorCloud()?.cloudFeatures() ?? null
  const cloud: CloudTakes =
    features === null
      ? 'not_connected'
      : features.has(CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE)
        ? 'yes'
        : 'no'
  if (!params.off) {
    return stateOf(bot, cloud)
  }
  if (cloud !== 'yes') {
    throw new InvalidArgumentError(
      cloud === 'no'
        ? 'Orca Cloud doesn’t take this switch yet, so the intro still posts. Try again after Orca Cloud updates.'
        : `${bot.name}’s Orca isn’t connected to Orca Cloud, so the intro can’t be turned off yet.`
    )
  }
  // From a bot's own chat, only a turn its owner asked for may change the owner's setting.
  if (callerBot) {
    const turnFor = caller
      ? await botTurnFor(runtime, caller, sessionCallerOf(context.orchestrationCaller)?.sessionId)
      : 'none'
    if (turnFor !== 'owner') {
      throw new InvalidArgumentError(
        'Only your owner can turn off your Slack intro. Ask them to, or to do it in Orca.'
      )
    }
  }
  // Read as saved, inside the update queue, so an owner's edit in Settings is not undone.
  const saved = await runtime.bots.update(bot.id, () => ({ slackChannelHello: false }))
  const state = stateOf(saved, cloud)
  const change = `Saved: ${saved.name} won’t post an intro when added to a Slack channel.`
  // The owner sees it in the bot's chat, wherever the command came from.
  noteInChat(caller ?? saved.chatSessionId ?? undefined, change)
  return { ...state, change }
}

export const BOT_SLACK_CHANNEL_HELLO_METHODS = [
  defineMethod({
    name: 'bots.slackChannelHello.set',
    permission: 'workspace',
    params: BotSlackChannelHelloSet,
    handler: setSlackChannelHello
  })
]
