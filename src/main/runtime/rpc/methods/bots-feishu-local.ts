import {
  FeishuLocalBot,
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
