import { BotItemsComment, BotItemsSet } from '../../shared/rpc-contract/bots-items-params'
import { EVAL_BOT, type EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'
import { RuntimeClientError } from '../runtime/connection/types'
import type { StandInIo } from './bot-orchestration-eval-orca'

export function serveEvalDecisionItem(
  state: EvalHostState,
  method: 'bots.items.set' | 'bots.items.comment',
  params: Record<string, unknown>,
  io: StandInIo
) {
  const seed = state.decisionItem
  const input =
    method === 'bots.items.set' ? BotItemsSet.parse(params) : BotItemsComment.parse(params)
  if (
    !seed ||
    seed.item.owner.botId !== EVAL_BOT.id ||
    seed.item.chat.id !== input.callerSessionId ||
    (input.item !== String(seed.item.number) && input.item !== seed.item.uid)
  ) {
    throw new RuntimeClientError(
      'not_found',
      'No decision item in this bot chat matches the request.'
    )
  }
  const comment = 'text' in input ? input.text : input.comment
  // Like the real host, a set may change only the status; it then posts no comment.
  if (!comment?.trim() && 'status' in input && input.status && !input.ask) {
    seed.item.status = input.status
    io.save(state)
    io.record({ kind: 'write', method, params, result: {} })
    return { item: seed.item }
  }
  if (!comment?.trim()) {
    throw new RuntimeClientError(
      'invalid_argument',
      'The decision item requires a question or comment.'
    )
  }
  const eventId = `decision-${seed.comments.length + 1}`
  seed.comments.push(comment)
  if ('status' in input && input.status) {
    seed.item.status = input.status
  }
  if ('ask' in input && input.ask) {
    seed.item.question = { eventId, text: comment }
  }
  io.save(state)
  io.record({ kind: 'write', method, params, result: { eventId } })
  return { item: seed.item, eventId }
}
