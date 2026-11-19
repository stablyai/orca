// Sharing a bot by link: build the candidate, publish it, move or stop the bot's one link.
import type { Bot } from '../../../../shared/bot-types'
import {
  BotSharePartView,
  BotSharePublish,
  BotSharePrepare,
  BotShareStatusParams,
  BotShareStop
} from '../../../../shared/rpc-contract/bots-share-params'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'

export const BOT_SHARE_OWNER_ONLY =
  'Only your owner shares a bot, in Orca: Settings, the bot, Share bot….'

/** Publishing puts the owner's bot on the web under their account, so every share call comes from
 *  the owner in Orca (a window or a paired device); any other caller, named or not, is refused. */
export function assertOwner(context: RpcContext): void {
  context.runtime.bots.assertEnabled()
  const kind = context.caller?.kind
  if (kind !== 'desktop' && kind !== 'paired-device') {
    throw new InvalidArgumentError(BOT_SHARE_OWNER_ONLY)
  }
}

function authorizedBot(context: RpcContext, botId: string): Bot {
  assertOwner(context)
  return botOf(context.runtime, botId)
}

function botOf(runtime: OrcaRuntimeService, botId: string): Bot {
  const bot = runtime.bots.list().find((entry) => entry.id === botId)
  if (!bot) {
    throw new InvalidArgumentError('No such bot.')
  }
  return bot
}

export const BOT_SHARE_METHODS = [
  defineMethod({
    name: 'bots.share.prepare',
    permission: 'workspace',
    params: BotSharePrepare,
    handler: async ({ botId, setupNote, last, localOnly, ...selection }, context) =>
      context.runtime
        .botShares()
        .prepare(authorizedBot(context, botId), selection, { setupNote, last, localOnly })
  }),
  defineMethod({
    name: 'bots.share.publish',
    permission: 'workspace',
    params: BotSharePublish,
    handler: async ({ botId, candidateId, setupNote = '', link }, context) => {
      const bot = authorizedBot(context, botId)
      const shares = context.runtime.botShares()
      return link
        ? shares.update(bot, candidateId, setupNote, link)
        : shares.publish(bot, candidateId, setupNote)
    }
  }),
  defineMethod({
    name: 'bots.share.view',
    permission: 'workspace',
    params: BotSharePartView,
    handler: async ({ botId, candidateId, part }, context) => ({
      files: await context.runtime
        .botShares()
        .view(authorizedBot(context, botId), candidateId, part)
    })
  }),
  defineMethod({
    name: 'bots.share.stop',
    permission: 'workspace',
    params: BotShareStop,
    handler: async ({ shareId, botId }, context) => {
      assertOwner(context)
      return context.runtime.botShares().stop(shareId, botId)
    }
  }),
  defineMethod({
    name: 'bots.share.status',
    permission: 'workspace',
    params: BotShareStatusParams,
    // Every live bot link the owner has; botShareStatusOf reads one bot's from it.
    handler: async ({ botId }, context) => {
      assertOwner(context)
      return context.runtime.botShares().list(context.runtime.bots.list(), botId)
    }
  })
]
