// `orca bot item …`: a bot's items over `bots.items.*`. Writes run from the bot's own chat, which the
// host checks.
import type { BotItemStatus } from '../../shared/bots/bot-items'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { readTextOrFileFlag } from '../arguments/command-body-input'
import { printResult } from '../output/command-result-output'
import {
  botItemJsonView,
  type BotItemsView,
  botItemStatusFlagWords,
  botItemStatusFromCli
} from './bot-item-cli-status'
import { RuntimeClientError } from '../runtime/connection/types'
import { callerChat } from '../automations/automation-caller-chat'
import { callBots, findBot } from './bot'
import { botItemAskFromFlags, botItemAskParams } from './bot-item-ask-flags'
import { BOT_ITEM_ASK_BOOLEAN_FLAGS } from '../specs/bot-items'
import {
  formatBotItemList,
  formatBotItemShow,
  formatBotItemWrite,
  type BotItemListView,
  type BotItemShowView,
  type BotItemWriteView
} from './bot-items-format'

type Flags = HandlerContext['flags']

function statusFlag(value: string): BotItemStatus {
  const known = botItemStatusFromCli(value)
  if (!known) {
    throw new RuntimeClientError('invalid_argument', `--status takes ${botItemStatusFlagWords()}`)
  }
  return known
}

/** --json prints statuses by their CLI names; the text formats name them in words. */
function print<T extends BotItemsView>(
  response: RuntimeRpcSuccess<T>,
  json: boolean,
  format: (value: T) => string
): void {
  if (json) {
    printResult({ ...response, result: botItemJsonView(response.result) }, true, () => '')
    return
  }
  printResult(response, false, format)
}

async function write(
  { client, json }: HandlerContext,
  method: string,
  params: Record<string, unknown>
): Promise<void> {
  const result = await callBots<BotItemWriteView>(client, method, { ...callerChat(), ...params })
  print(result, json, formatBotItemWrite)
}

function itemId(flags: Flags): string {
  return getRequiredStringFlag(flags, 'id')
}

function optional(name: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [name]: value }
}

export const BOT_ITEM_HANDLERS: Record<string, CommandHandler> = {
  'bot item add': async (ctx) => {
    const { flags, cwd } = ctx
    const status = getOptionalStringFlag(flags, 'status')
    const links = getRepeatedStringFlag(flags, 'link')
    await write(ctx, 'bots.items.add', {
      title: getRequiredStringFlag(flags, 'title'),
      ...optional('description', await readTextOrFileFlag(flags, cwd, 'description', false)),
      ...optional('doneMeans', await readTextOrFileFlag(flags, cwd, 'done-means', false)),
      ...(status ? { status: statusFlag(status) } : {}),
      ...(links.length > 0 ? { links } : {}),
      ...optional('forBot', getOptionalStringFlag(flags, 'for')),
      ...optional('chat', getOptionalStringFlag(flags, 'chat'))
    })
  },
  'bot item set': async (ctx) => {
    const { flags, cwd } = ctx
    const status = getOptionalStringFlag(flags, 'status')
    const ask = botItemAskFromFlags(ctx, BOT_ITEM_ASK_BOOLEAN_FLAGS)
    const comment = await readTextOrFileFlag(flags, cwd, 'comment', false)
    await write(ctx, 'bots.items.set', {
      item: itemId(flags),
      ...optional('title', getOptionalStringFlag(flags, 'title')),
      ...optional('description', await readTextOrFileFlag(flags, cwd, 'description', false)),
      ...optional('doneMeans', await readTextOrFileFlag(flags, cwd, 'done-means', false)),
      ...(status ? { status: statusFlag(status) } : {}),
      ...optional('note', await readTextOrFileFlag(flags, cwd, 'note', false)),
      ...optional('reason', await readTextOrFileFlag(flags, cwd, 'reason', false)),
      ...(ask ? botItemAskParams(ask, comment) : optional('comment', comment))
    })
  },
  'bot item comment': async (ctx) => {
    const { flags, cwd } = ctx
    await write(ctx, 'bots.items.comment', {
      item: itemId(flags),
      text: await readTextOrFileFlag(flags, cwd, 'text', true)
    })
  },
  'bot item done': async (ctx) => {
    const { flags, cwd } = ctx
    await write(ctx, 'bots.items.done', {
      item: itemId(flags),
      ...optional('note', await readTextOrFileFlag(flags, cwd, 'note', false))
    })
  },
  'bot item cancel': async (ctx) => {
    const { flags, cwd } = ctx
    await write(ctx, 'bots.items.cancel', {
      item: itemId(flags),
      reason: await readTextOrFileFlag(flags, cwd, 'reason', true)
    })
  },
  'bot item link': async (ctx) => {
    await write(ctx, 'bots.items.link', {
      item: itemId(ctx.flags),
      refs: getRepeatedStringFlag(ctx.flags, 'ref')
    })
  },
  'bot item list': async ({ flags, client, json }) => {
    const selector = getOptionalStringFlag(flags, 'bot')
    const botId = selector ? (await findBot(client, selector)).id : undefined
    const status = getOptionalStringFlag(flags, 'status')
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    const result = await callBots<BotItemListView>(client, 'bots.items.list', {
      ...callerChat(),
      ...(botId ? { botId } : {}),
      ...(status ? { statuses: status.split(',').map(statusFlag) } : {}),
      ...(flags.has('all') ? { all: true } : {}),
      ...(flags.has('here') ? { here: true } : {}),
      ...optional('chat', getOptionalStringFlag(flags, 'chat')),
      ...optional('link', getOptionalStringFlag(flags, 'link')),
      ...(limit !== undefined ? { limit } : {}),
      ...optional('cursor', getOptionalStringFlag(flags, 'cursor'))
    })
    print(result, json, (value) => formatBotItemList(value, Date.now()))
  },
  'bot item show': async ({ flags, client, json }) => {
    const result = await callBots<BotItemShowView>(client, 'bots.items.show', {
      ...callerChat(),
      item: itemId(flags),
      ...optional('after', getOptionalStringFlag(flags, 'after'))
    })
    print(result, json, formatBotItemShow)
  }
}
