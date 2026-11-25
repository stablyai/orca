// `orca bot item …`: a bot's items over `bots.items.*`. Writes run from the bot's own chat, which the
// host checks.
import type { BotItemStatus } from '../../shared/bots/bot-items'
import { BOTS_ITEM_SET_VERSION_RUNTIME_CAPABILITY } from '../../shared/bot-runtime-capabilities'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { resolve } from 'node:path'
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
import { botItemAskAdviceWithout } from '../../shared/bots/bot-item-ask-advice'
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
  { client, json, flags }: HandlerContext,
  method: string,
  params: Record<string, unknown>
): Promise<void> {
  const result = await callBots<BotItemWriteView>(client, method, { ...callerChat(), ...params })
  const { advice, ...view } = result.result
  // Context read from --comment-file already follows the long-context tip; only the CLI knows.
  const kept =
    advice && flags.has('comment-file') ? botItemAskAdviceWithout(advice, 'long_context') : advice
  print({ ...result, result: kept ? { ...view, advice: kept } : view }, json, formatBotItemWrite)
}

function itemId(flags: Flags): string {
  return getRequiredStringFlag(flags, 'id')
}

function optional(name: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [name]: value }
}

/** `--file`, each resolved against the caller's folder: the host copies them from its own disk. */
function files(flags: Flags, cwd: string): { files?: string[] } {
  const paths = getRepeatedStringFlag(flags, 'file').map((path) => resolve(cwd, path))
  return paths.length > 0 ? { files: paths } : {}
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
    const { flags, cwd, client } = ctx
    const status = getOptionalStringFlag(flags, 'status')
    const expectedVersion = getOptionalPositiveIntegerFlag(flags, 'expected-version')
    const ask = botItemAskFromFlags(ctx, BOT_ITEM_ASK_BOOLEAN_FLAGS)
    const comment = await readTextOrFileFlag(flags, cwd, 'comment', false)
    if (flags.has('expected-version')) {
      if (expectedVersion === undefined) {
        throw new RuntimeClientError(
          'invalid_argument',
          '--expected-version needs a positive integer.'
        )
      }
      const { result } = await client.call<RuntimeStatus>('status.get')
      if (!result.capabilities?.includes(BOTS_ITEM_SET_VERSION_RUNTIME_CAPABILITY)) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'This Orca host cannot check an item version before writing. Update Orca on that host.'
        )
      }
    }
    await write(ctx, 'bots.items.set', {
      item: itemId(flags),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      ...optional('title', getOptionalStringFlag(flags, 'title')),
      ...optional('description', await readTextOrFileFlag(flags, cwd, 'description', false)),
      ...optional('doneMeans', await readTextOrFileFlag(flags, cwd, 'done-means', false)),
      ...(status ? { status: statusFlag(status) } : {}),
      ...optional('note', await readTextOrFileFlag(flags, cwd, 'note', false)),
      ...optional('reason', await readTextOrFileFlag(flags, cwd, 'reason', false)),
      ...(ask ? botItemAskParams(ask, comment) : optional('comment', comment)),
      ...files(flags, cwd)
    })
  },
  'bot item comment': async (ctx) => {
    const { flags, cwd } = ctx
    const attached = files(flags, cwd)
    await write(ctx, 'bots.items.comment', {
      item: itemId(flags),
      // Files alone make a comment.
      text: (await readTextOrFileFlag(flags, cwd, 'text', !attached.files)) ?? '',
      ...attached
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
