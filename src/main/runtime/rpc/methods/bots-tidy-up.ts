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

// Whether each bot's latest summary row was undone. A poll never waits on slow history behind a check
// already running: it answers with the last known result while one check per bot refreshes it.
const undoneByBot = new Map<
  string,
  { rowId: string; known: boolean | undefined; check: Promise<boolean> | null }
>()
function undoneCheck(
  memory: Pick<BotMemoryRecord, 'history'>,
  botId: string,
  rowId: string,
  fresh: boolean
): Promise<boolean> | boolean {
  let entry = undoneByBot.get(botId)
  if (entry?.rowId !== rowId) {
    entry = { rowId, known: undefined, check: null }
    undoneByBot.set(botId, entry)
  }
  const current = entry
  const check = (): Promise<boolean> =>
    memory
      .history(botId)
      .then((rows) => rows.some((row) => row.by.kind === 'undo' && row.by.of === rowId))
      .then((undone) => {
        current.known = undone
        return undone
      })
  if (fresh) {
    // Read behind the Undo's own row, so its answer can't be an earlier check's.
    return check()
  }
  if (current.check) {
    return current.known ?? false
  }
  current.check = check().finally(() => {
    current.check = null
  })
  return current.known ?? current.check
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
