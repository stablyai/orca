import * as z from 'zod'
import { BotMemoryHistoryRowSchema } from '../../../../src/shared/bots/bot-memory-history'
import { BOT_MEMORY_NO_FACT } from '../../../../src/shared/bot-memory-quick-add'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'

// A bot's MEMORY.md as Settings changes it on the bot's host, so each change lands in its history.
export const botMemoryEdit = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.memory.edit',
    method: 'bots.memory.edit',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'memory-edited',
      z.looseObject({ alreadyInMemory: z.boolean().optional() })
    )
  })
)

/** What the host's reply to an add or edit says; a refused add with no words throws `noFact`, the
 *  owner's words for it, instead of the host's code. */
export function interpretBotMemoryEdit(
  response: RpcResponse,
  noFact: string
): { alreadyInMemory?: boolean } {
  try {
    return botMemoryEdit.interpret(response)
  } catch (error) {
    throw error instanceof Error && error.message === BOT_MEMORY_NO_FACT ? new Error(noFact) : error
  }
}

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
