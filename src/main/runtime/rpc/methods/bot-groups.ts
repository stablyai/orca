import {
  BotGroupCreate,
  BotGroupRead,
  BotGroupSend,
  BotGroupUpdate,
  BotGroupStop,
  BotGroupDelete,
  BotGroupNewThread,
  BotGroupReorder
} from '../../../../shared/bots/bot-group'
import { runtimeBotGroups } from '../../../bots/bot-group-runtime'
import { defineMethod, type RpcContext } from '../core'

/** Rooms are run by their human owner, on the desktop or a paired device. */
export function assertBotGroupOwner(context: Pick<RpcContext, 'caller'>): void {
  if (context.caller?.kind === 'desktop' || context.caller?.kind === 'paired-device') {
    return
  }
  throw new Error(
    'Use the group chat as its human owner. Bots use the explicit question or handoff action.'
  )
}

export const BOT_GROUP_METHODS = [
  defineMethod({
    name: 'bots.groups.list',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => ({
      groups: runtime.bots.enabled() ? runtimeBotGroups(runtime).store.listing() : []
    })
  }),
  defineMethod({
    name: 'bots.groups.create',
    permission: 'workspace',
    params: BotGroupCreate,
    handler: async (params, context) => {
      assertBotGroupOwner(context)
      return { group: await runtimeBotGroups(context.runtime).create(params) }
    }
  }),
  defineMethod({
    name: 'bots.groups.update',
    permission: 'workspace',
    params: BotGroupUpdate,
    handler: async (params, context) => {
      assertBotGroupOwner(context)
      return { group: await runtimeBotGroups(context.runtime).update(params) }
    }
  }),
  defineMethod({
    name: 'bots.groups.reorder',
    permission: 'workspace',
    params: BotGroupReorder,
    handler: (params, context) => {
      assertBotGroupOwner(context)
      const groups = runtimeBotGroups(context.runtime)
      groups.store.get(params.groupId)
      groups.store.setSidebarOrder(params.groupId, params.sidebarOrder)
      groups.changed()
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'bots.groups.read',
    permission: 'workspace',
    params: BotGroupRead,
    handler: async (params, context) => {
      assertBotGroupOwner(context)
      return runtimeBotGroups(context.runtime).read(
        params.groupId,
        params.beforeSequence,
        params.threadId
      )
    }
  }),
  defineMethod({
    name: 'bots.groups.send',
    permission: 'workspace',
    params: BotGroupSend,
    handler: async (params, context) => {
      assertBotGroupOwner(context)
      return { message: await runtimeBotGroups(context.runtime).send(params) }
    }
  }),
  defineMethod({
    name: 'bots.groups.stop',
    permission: 'workspace',
    params: BotGroupStop,
    handler: async (params, context) => {
      assertBotGroupOwner(context)
      return {
        results: await runtimeBotGroups(context.runtime).stop(
          params.groupId,
          params.botId,
          params.threadId
        )
      }
    }
  }),
  defineMethod({
    name: 'bots.groups.newThread',
    permission: 'workspace',
    params: BotGroupNewThread,
    handler: async (params, context) => {
      assertBotGroupOwner(context)
      return runtimeBotGroups(context.runtime).newThread(params.groupId)
    }
  }),
  defineMethod({
    name: 'bots.groups.delete',
    permission: 'workspace',
    params: BotGroupDelete,
    handler: async (params, context) => {
      assertBotGroupOwner(context)
      await runtimeBotGroups(context.runtime).delete(params.groupId)
      return { deleted: true }
    }
  })
]
