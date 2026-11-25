import * as z from 'zod'
import { BotMemoryHistoryRowSchema } from '../../../../src/shared/bots/bot-memory-history'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'

// A bot's MEMORY.md as Settings changes it on the bot's host, so each change lands in its history.
export const botMemoryEdit = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.memory.edit',
    method: 'bots.memory.edit',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('memory-edited', z.unknown())
  })
)

export const botMemoryForget = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.memory.forget',
    method: 'bots.memory.forget',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('memory-forgot', z.unknown())
  })
)

export const botMemoryHistory = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.memory.history',
    method: 'bots.memory.history',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'memory-history',
      z.looseObject({
        rows: z.array(BotMemoryHistoryRowSchema.extend({ chat: z.string().nullable() }))
      })
    )
  })
)

export const botMemoryUndo = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.memory.undo',
    method: 'bots.memory.undo',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('memory-undone', z.looseObject({ undone: z.boolean() }))
  })
)
