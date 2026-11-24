// One end at a time per bot, and a repeat of the same op (same id, caller, chat and intent) gets its
// first answer back rather than acting twice. An op id is reserved the moment it arrives, across every
// bot's lane, so the same id can never run twice at once. Answers are kept for ten minutes, at most
// 256 of them; a later repeat is a new op, which an `x` whose tab is gone answers as superseded.
import type { BotChatEndResult } from '../../../shared/bots/bot-chat-end'
import { runKeyedSerializedOperation } from '../../../shared/concurrency/keyed-serialized-operations'

const KEEP_MS = 10 * 60_000
const KEEP_MAX = 256

/** `at`: when it answered; null while it runs, which is never forgotten. */
type Reserved = { key: string; at: number | null; result: Promise<BotChatEndResult> }

const ops = new Map<string, Reserved>()
const queues = new Map<string, Promise<void>>()

export class BotChatEndOpConflict extends Error {
  constructor() {
    super('That op id was already used for another request.')
  }
}

function forgetOld(now: number): void {
  for (const [opId, kept] of ops) {
    if (kept.at !== null && (now - kept.at > KEEP_MS || ops.size > KEEP_MAX)) {
      ops.delete(opId)
    }
  }
}

export function runBotChatEndOp(
  op: { opId: string; key: string; botId: string; now: () => number },
  run: () => Promise<BotChatEndResult>
): Promise<BotChatEndResult> {
  forgetOld(op.now())
  const reserved = ops.get(op.opId)
  if (reserved) {
    return reserved.key === op.key ? reserved.result : Promise.reject(new BotChatEndOpConflict())
  }
  const entry: Reserved = {
    key: op.key,
    at: null,
    result: runKeyedSerializedOperation(queues, op.botId, run)
  }
  ops.set(op.opId, entry)
  entry.result.then(
    () => {
      entry.at = op.now()
    },
    // A failed op has no answer to repeat; the same id may run again.
    () => {
      if (ops.get(op.opId) === entry) {
        ops.delete(op.opId)
      }
    }
  )
  return entry.result
}

export function resetBotChatEndOpsForTests(): void {
  ops.clear()
  queues.clear()
}
