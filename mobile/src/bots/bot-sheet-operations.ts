import * as z from 'zod'
import {
  BotActivityViewSchema,
  type BotActivityView,
  type BotActivityViewOrigin,
  type BotActivityViewRow
} from '../../../src/shared/bots/bot-activity-schema'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import { phoneBotReply, type PhoneBot } from './host-bots-operations'
import { botMemberSource, type BotMember } from '../../../src/shared/bot-types'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

export type SheetBot = PhoneBot

export const botUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.update',
    method: 'bots.update',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('sheet-bot-updated', phoneBotReply)
  })
)

/** A New bot from the phone; the host speaks first in its Home Chat, as for one made on the desktop. */
export const botCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.create',
    method: 'bots.create',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-created', phoneBotReply)
  })
)

export const botSessionStart = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.session-start',
    method: 'bots.session.start',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-session-started', z.looseObject({ sessionId: z.string().min(1) }))
  })
)

export type SheetActivity = BotActivityView
export type SheetActivityRow = BotActivityViewRow
export type SheetActivityOrigin = BotActivityViewOrigin

export const botActivityRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.activity-or-skip',
    method: 'bots.activity',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-activity', z.looseObject({ activity: BotActivityViewSchema }))
  })
)

/** Keep only me: one removal each, on the host, so a concurrent edit is kept and an older host
 *  takes it. Resolves to the names of whoever couldn't be removed. */
export async function removeEveryoneWhoCanAsk(
  client: RpcClient,
  bot: { id: string; members: readonly BotMember[] },
  onBot: (bot: PhoneBot) => void
): Promise<string[]> {
  const failed: string[] = []
  for (const member of bot.members) {
    const removeMember = {
      id: member.id,
      source: botMemberSource(member),
      ...(member.workspaceId ? { workspaceId: member.workspaceId } : {})
    }
    try {
      onBot(
        botUpdate.interpret(
          await botUpdate.request(
            client,
            { botId: bot.id, updates: { removeMember } },
            { failWhenDisconnected: true }
          )
        ).bot
      )
    } catch {
      failed.push(member.name || member.id)
    }
  }
  return failed
}
