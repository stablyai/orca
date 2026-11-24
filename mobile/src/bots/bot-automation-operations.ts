import * as z from 'zod'
import { BotAutomationViewSchema } from '../../../src/shared/bots/bot-activity-schema'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

// The bot's automations come composed with its Activity; these are the phone's two writes.
export const automationRunNow = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'automation.run-now',
    method: 'automation.runNow',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('automation-run-started', z.unknown())
  })
)

export const automationSetEnabled = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'automation.set-enabled',
    method: 'automation.update',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'automation-enabled-set',
      z.looseObject({ automation: BotAutomationViewSchema })
    )
  })
)
