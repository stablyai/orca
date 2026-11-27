import * as z from 'zod'
import { BotTidyUpViewSchema } from '../../../src/shared/bots/bot-tidy-up'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

// A bot's Tidy-up on its host: its state and last summary, Tidy now, and Undo of the last one.
export const tidyUpGet = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tidy-up.get',
    method: 'bots.tidyUp.get',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('tidy-up', z.looseObject({ tidyUp: BotTidyUpViewSchema }))
  })
)

export const tidyUpNow = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tidy-up.now',
    method: 'bots.tidyUp.now',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('tidy-up-started', z.unknown())
  })
)

export const tidyUpUndo = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.tidy-up.undo',
    method: 'bots.tidyUp.undo',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'tidy-up-undone',
      z.looseObject({ undone: z.boolean(), tidyUp: BotTidyUpViewSchema })
    )
  })
)
