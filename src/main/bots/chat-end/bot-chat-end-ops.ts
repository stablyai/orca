// One end at a time per bot, and a repeat of the same op (same id, caller, chat and intent) gets its
// first answer back rather than acting twice. Answers are kept for ten minutes, at most 256 of them;
// a later repeat is a new op, which an `x` whose tab is gone answers as superseded.
import type { BotChatEndResult } from '../../../shared/bots/bot-chat-end'
import { runKeyedSerializedOperation } from '../../../shared/concurrency/keyed-serialized-operations'

const KEEP_MS = 10 * 60_000
const KEEP_MAX = 256

type Kept = { key: string; at: number; result: BotChatEndResult }

const answers = new Map<string, Kept>()
const queues = new Map<string, Promise<void>>()

export class BotChatEndOpConflict extends Error {
  constructor() {
    super('That op id was already used for another request.')
  }
}

function forgetOld(now: number): void {
  for (const [opId, kept] of answers) {
    if (now - kept.at > KEEP_MS || answers.size > KEEP_MAX) {
      answers.delete(opId)
    }
  }
}

export function runBotChatEndOp(
  op: { opId: string; key: string; botId: string; now: () => number },
  run: () => Promise<BotChatEndResult>
): Promise<BotChatEndResult> {
  return runKeyedSerializedOperation(queues, op.botId, async () => {
    forgetOld(op.now())
    const kept = answers.get(op.opId)
    if (kept) {
      if (kept.key !== op.key) {
        throw new BotChatEndOpConflict()
      }
      return kept.result
    }
    const result = await run()
    answers.set(op.opId, { key: op.key, at: op.now(), result })
    return result
  })
}

export function resetBotChatEndOpsForTests(): void {
  answers.clear()
  queues.clear()
}
