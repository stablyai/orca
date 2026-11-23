import type { ConnectorTurnFor } from '../../shared/connectors/connector-cloud-contract'
import type { BotTurnAddress } from './bot-work-types'

export type FailedBotWorkerStart = {
  taskId: string
  reason: string
  machine: string
}

/** Posts the one failure notice a Slack-started bot worker owns. The task key makes retries idempotent. */
export async function postFailedBotWorkerStart(
  turn: BotTurnAddress | null,
  start: FailedBotWorkerStart,
  post: (input: {
    replyId: string
    conversation: BotTurnAddress['address']
    text: string
    turnFor: ConnectorTurnFor
  }) => Promise<unknown>,
  turnFor: ConnectorTurnFor
): Promise<void> {
  if (!turn || turn.address.source !== 'slack') {
    return
  }
  await post({
    replyId: `worker-start-failed:${start.taskId}`,
    conversation: turn.address,
    text: `I couldn't start the worker on ${start.machine}: ${start.reason}. Please retry it or check the bot's Chat.`,
    turnFor
  })
}
