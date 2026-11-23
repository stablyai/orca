import type { ConnectorTurnFor } from '../../shared/connectors/connector-cloud-contract'
import type { BotTurnAddress } from './bot-work-types'

export type FailedBotWorkerStart = {
  taskId: string
  reason: string
  machine: string
}

/** Posts the one failure notice a Slack-started bot worker owns. The task key makes retries idempotent;
 *  turnFor none keeps an Orca notice from counting as anyone's post. */
export async function postFailedBotWorkerStart(
  turn: BotTurnAddress | null,
  start: FailedBotWorkerStart,
  post: (input: {
    replyId: string
    conversation: BotTurnAddress['address']
    text: string
    turnFor: ConnectorTurnFor
  }) => Promise<unknown>
): Promise<void> {
  if (!turn || turn.askedInApp || turn.address.source !== 'slack') {
    return
  }
  await post({
    replyId: `worker-start-failed:${start.taskId}`,
    conversation: turn.address,
    text: `I couldn't start the worker on ${start.machine}. ${asSentence(start.reason)} Please retry it or check the bot's Chat.`,
    turnFor: 'none'
  })
}

function asSentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}
