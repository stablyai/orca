// `orca bot reply --react`: the calling bot's emoji on the message that woke its run, as the bot.
import { ConnectorReact } from '../../../../shared/rpc-contract/connectors/connector-params'
import { defineMethod } from '../core'
import { CONNECTOR_ACT_METHOD, ConnectorActError } from './connector-act'
import { readBotTurn } from './orchestration/messaging/bot-recipient'
import type { BotRequestConversation, BotWakingPlace } from '../../../bots/bot-request-asker'

/** The message a react goes on: the one the cloud named. From an older cloud, on GitHub the comment
 *  by its link, in Slack the thread's first message; Linear's links name no message it can find. */
export function wakingMessageRef(
  woken: BotWakingPlace,
  conversation: BotRequestConversation
): string | null {
  if (woken.messageRef) {
    return woken.messageRef
  }
  // An older cloud names no message: the closest it can.
  if (woken.source === 'github') {
    return woken.url ?? null
  }
  if (woken.source !== 'slack' || conversation.source !== 'slack') {
    return null
  }
  // `team:channel:thread:botUser`, the cloud's perThreadBotConversationId.
  const [team, channel, thread] = conversation.externalId.split(':')
  return team && channel && thread
    ? ['slack', team, channel, thread, thread].map((part) => encodeURIComponent(part)).join(':')
    : null
}

const NO_MESSAGE =
  'Nothing to react to: no Slack or GitHub message woke this run. Reply with `orca bot reply --text` instead.'

export const CONNECTOR_REACT_METHOD = defineMethod({
  name: 'connector.react',
  permission: 'workspace',
  share: 'not-shared',
  params: ConnectorReact,
  handler: async ({ sessionId, emoji }, context) => {
    const { runtime } = context
    const { turn, conversation } = runtime.bots.enabled()
      ? await readBotTurn(runtime, runtime.getOrchestrationDb(), sessionId)
      : { turn: null, conversation: null }
    const ref = conversation && turn?.wokenAt ? wakingMessageRef(turn.wokenAt, conversation) : null
    if (!ref) {
      throw new ConnectorActError('no_waking_message', NO_MESSAGE)
    }
    // The same path as any verb, so the bot, look-around and cloud checks hold.
    const answer = await CONNECTOR_ACT_METHOD.handler(
      { sessionId, verb: 'react', ref, args: { emoji } },
      context
    )
    if (!answer.ok) {
      throw new ConnectorActError('connector_refused', answer.message)
    }
    return { ok: true as const }
  }
})
