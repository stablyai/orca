import * as z from 'zod'
import { BotGroupSchema, BotGroupMessageSchema } from '../../../src/shared/bots/bot-group-schema'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

export const groupList = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bot-groups.list',
    method: 'bots.groups.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('groups', z.object({ groups: z.array(BotGroupSchema) }))
  })
)
export const groupRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bot-groups.read',
    method: 'bots.groups.read',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'group',
      z.object({
        group: BotGroupSchema,
        messages: z.array(BotGroupMessageSchema),
        hasEarlier: z.boolean()
      })
    )
  })
)
export const groupCreate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bot-groups.create',
    method: 'bots.groups.create',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('group-created', z.object({ group: BotGroupSchema }))
  })
)
export const groupUpdate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bot-groups.update',
    method: 'bots.groups.update',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('group-updated', z.object({ group: BotGroupSchema }))
  })
)
export const groupSend = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bot-groups.send',
    method: 'bots.groups.send',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('group-sent', z.object({ message: BotGroupMessageSchema }))
  })
)
export const groupStop = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bot-groups.stop',
    method: 'bots.groups.stop',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'group-stopped',
      z.object({
        results: z.array(
          z.object({ ok: z.boolean(), refusal: z.object({ message: z.string() }).optional() })
        )
      })
    )
  })
)
export const groupNewThread = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bot-groups.new-thread',
    method: 'bots.groups.newThread',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'group-thread',
      z.object({ group: BotGroupSchema, threadId: z.string().min(1) })
    )
  })
)
/** A group's place among the Bots section's rows, as a drag on the desktop saves it. */
export const groupReorder = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bot-groups.reorder',
    method: 'bots.groups.reorder',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('group-reordered', z.object({ ok: z.literal(true) }))
  })
)
export const groupDelete = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bot-groups.delete',
    method: 'bots.groups.delete',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('group-deleted', z.object({}))
  })
)

/** What each bot is for, from its SOUL.md. */
export const botRoster = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bot-groups.roster',
    method: 'bots.roster',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'roster',
      z.object({
        bots: z.array(z.object({ id: z.string(), specialty: z.string().nullable() }))
      })
    )
  })
)
