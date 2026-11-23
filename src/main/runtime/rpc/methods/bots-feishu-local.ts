import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import { chatPaneKey } from '../../../external-conversations/external-conversation-chat'
import { botTurnFor } from '../../../bots/bot-turn-for'
import {
  FeishuLocalBot,
  FeishuGeneratedFile,
  FeishuLocalConnect
} from '../../../../shared/rpc-contract/bots-feishu-local-params'
import { defineMethod, type RpcContext } from '../core'

function host(context: RpcContext) {
  const host = context.runtime.feishuLocal
  if (!host) {
    throw new Error('Local Feishu setup is unavailable on this host')
  }
  return host
}
export const BOT_FEISHU_LOCAL_METHODS = [
  defineMethod({
    name: 'bots.feishuLocal.stageFile',
    permission: 'workspace',
    params: FeishuGeneratedFile,
    handler: async ({ sessionId, name, base64 }, context) => {
      const caller = sessionCallerOf(context.orchestrationCaller)?.sessionId
      if (
        caller !== sessionId ||
        (await botTurnFor(context.runtime, sessionId, caller)) !== 'owner'
      ) {
        throw new Error('Only the owner’s active Feishu DM turn can stage a file')
      }
      const target = context.runtime
        .getExternalConversationSeam()
        ?.replyTarget(chatPaneKey(sessionId))
      if (target?.key.source !== 'feishu-local' || target.bot?.kind !== 'bot') {
        throw new Error('This session is not a linked Feishu bot conversation')
      }
      if (target.turnId === null) {
        throw new Error('The Feishu DM turn is no longer active')
      }
      if (!target.answerDeliveryId) {
        throw new Error('The active turn has no original Feishu delivery stamp')
      }
      await host(context).stageFile(
        target.bot.botId,
        target.key.externalId,
        target.answerDeliveryId,
        name,
        Buffer.from(base64, 'base64')
      )
      return { staged: true }
    }
  }),
  defineMethod({
    name: 'bots.feishuLocal.state',
    permission: 'accounts-admin',
    params: FeishuLocalBot,
    handler: ({ botId }, context) => host(context).state(botId)
  }),
  defineMethod({
    name: 'bots.feishuLocal.profiles',
    permission: 'accounts-admin',
    params: null,
    handler: (_, context) => host(context).profiles()
  }),
  defineMethod({
    name: 'bots.feishuLocal.connect',
    permission: 'accounts-admin',
    params: FeishuLocalConnect,
    handler: async ({ botId, profile }, context) => {
      await host(context).connect(botId, profile)
      return host(context).state(botId)
    }
  }),
  defineMethod({
    name: 'bots.feishuLocal.remove',
    permission: 'accounts-admin',
    params: FeishuLocalBot,
    handler: async ({ botId }, context) => {
      await host(context).remove(botId)
      return host(context).state(botId)
    }
  })
]
