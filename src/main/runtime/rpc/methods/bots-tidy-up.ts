// Tidy-up over RPC: its state and last summary for Settings and the phone, Tidy now, and Undo of the
// last one, which reverts that run's one History row.
import { botTidyUp, type BotTidyUpView } from '../../../../shared/bots/bot-tidy-up'
import {
  BotTidyUpAct,
  BotTidyUpUndo
} from '../../../../shared/rpc-contract/bots-look-around-params'
import { botHomeFolder } from '../../../bots/bot-home'
import {
  failedLooksInARow,
  LOOK_FAILURES_TO_TURN_OFF
} from '../../../bots/bot-look-around-failures'
import type { BotMemoryRecord } from '../../../bots/bot-memory-record'
import { tidyUpState } from '../../../bots/bot-memory-tidy-up'
import { runtimeTidyUpRunner } from '../../../bots/bot-memory-tidy-up-runtime'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'

function botById(context: RpcContext, botId: string) {
  context.runtime.bots.assertEnabled()
  const bot = context.runtime.bots.list().find((entry) => entry.id === botId)
  if (!bot) {
    throw new InvalidArgumentError('bot_not_found')
  }
  return bot
}

// Whether a summary row was undone, read from history. Reads at the same time share one check, and a
// view waits for it at most this long: behind a stalled disk a poll answers "not undone" instead of
// piling up, and the next read after the check lands starts a fresh one.
const UNDONE_CHECK_WAIT_MS = 2_000
const undoneChecks = new Map<string, Promise<boolean>>()

const undoneIn = (memory: Pick<BotMemoryRecord, 'history'>, botId: string, rowId: string) =>
  memory
    .history(botId)
    .then((rows) => rows.some((row) => row.by.kind === 'undo' && row.by.of === rowId))

async function undoneCheck(
  memory: Pick<BotMemoryRecord, 'history'>,
  botId: string,
  rowId: string,
  fresh: boolean
): Promise<boolean> {
  if (fresh) {
    // Read behind the Undo's own row, so its answer can't be an earlier check's.
    return await undoneIn(memory, botId, rowId)
  }
  const key = `${botId}\u0000${rowId}`
  let check = undoneChecks.get(key)
  if (!check) {
    check = undoneIn(memory, botId, rowId).finally(() => undoneChecks.delete(key))
    // A view that stopped waiting no longer observes it.
    check.catch(() => {})
    undoneChecks.set(key, check)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      check,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), UNDONE_CHECK_WAIT_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function botTidyUpView(
  context: RpcContext,
  botId: string,
  options: { fresh?: boolean } = {}
): Promise<BotTidyUpView> {
  const bot = botById(context, botId)
  const { runtime } = context
  const setting = botTidyUp(bot)
  const state = tidyUpState(runtime.lookAround.get(bot.id))
  const lastRun = state.runs.at(-1)
  const rowId = state.last?.rowId
  const undone =
    rowId != null && (await undoneCheck(runtime.bots.memory, bot.id, rowId, options.fresh === true))
  return {
    setting,
    last: state.last ? { ...state.last, undone } : null,
    running: lastRun !== undefined && lastRun.endedAt === undefined,
    turnedOff:
      !setting.on && failedLooksInARow(state) >= LOOK_FAILURES_TO_TURN_OFF
        ? (lastRun?.error ?? null)
        : null,
    error: lastRun?.endedAt !== undefined ? (lastRun.error ?? null) : null
  }
}

export const BOT_TIDY_UP_METHODS = [
  defineMethod({
    name: 'bots.tidyUp.get',
    permission: 'workspace',
    params: BotTidyUpAct,
    handler: async (params, context) => ({ tidyUp: await botTidyUpView(context, params.botId) })
  }),
  defineMethod({
    name: 'bots.tidyUp.now',
    permission: 'workspace',
    params: BotTidyUpAct,
    handler: (params, context) => {
      botById(context, params.botId)
      const outcome = runtimeTidyUpRunner(context.runtime).tidyNow(params.botId)
      if ('refused' in outcome) {
        throw new InvalidArgumentError(`tidy_now_${outcome.refused}`)
      }
      return outcome
    }
  }),
  defineMethod({
    name: 'bots.tidyUp.undo',
    permission: 'workspace',
    params: BotTidyUpUndo,
    handler: async (params, context) => {
      const bot = botById(context, params.botId)
      // A summary the client shows that a newer run has since replaced: it reloads, undoes nothing.
      if (tidyUpState(context.runtime.lookAround.get(bot.id)).last?.rowId !== params.rowId) {
        throw new InvalidArgumentError('tidy_up_stale')
      }
      const undone = await context.runtime.bots.memory.undo(
        bot.id,
        botHomeFolder(bot),
        params.rowId
      )
      return { undone, tidyUp: await botTidyUpView(context, bot.id, { fresh: true }) }
    }
  })
]
