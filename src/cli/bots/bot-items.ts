// `orca bot item …`: a bot's items over `bots.items.*`. Writes run from the bot's own chat, which the
// host checks.
import { z } from 'zod'
import type { BotItemStatus } from '../../shared/bots/bot-items'
import { BOTS_ITEM_SET_VERSION_RUNTIME_CAPABILITY } from '../../shared/bots/bot-item-version-capability'
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
import { resolveCallerFilePath } from '../arguments/caller-file-path'

type Flags = HandlerContext['flags']
const ItemVersionHostStatus = z.object({ capabilities: z.array(z.string()).optional() })

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
  params: Record<string, unknown> & { expectedVersion?: number }
): Promise<void> {
  const request = { ...callerChat(), ...params }
  const result =
    params.expectedVersion === undefined
      ? await callBots<BotItemWriteView>(client, method, request)
      : await client.call<BotItemWriteView>(method, request, {
          requestSelection: {
            paramsForStatus: (raw) => {
              const status = ItemVersionHostStatus.safeParse(raw)
              if (!status.success) {
                throw new RuntimeClientError(
                  'invalid_runtime_response',
                  'The Orca host returned an invalid status response.'
                )
              }
              if (!status.data.capabilities?.includes(BOTS_ITEM_SET_VERSION_RUNTIME_CAPABILITY)) {
                throw new RuntimeClientError(
                  'incompatible_runtime',
                  'This Orca host cannot check an item version before writing. Update Orca on that host.'
                )
              }
              return request
            }
          }
        })
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
  const paths = getRepeatedStringFlag(flags, 'file').map((path) => resolveCallerFilePath(path, cwd))
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
    const { flags, cwd } = ctx
    const status = getOptionalStringFlag(flags, 'status')
    const expectedVersion = getOptionalPositiveIntegerFlag(flags, 'expected-version')
    if (flags.has('expected-version') && expectedVersion === undefined) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--expected-version needs a positive integer.'
      )
    }
    const ask = botItemAskFromFlags(ctx, BOT_ITEM_ASK_BOOLEAN_FLAGS)
    const comment = await readTextOrFileFlag(flags, cwd, 'comment', false)
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
