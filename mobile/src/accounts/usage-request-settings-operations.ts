import { z } from 'zod'
import { USAGE_REQUEST_PROVIDERS } from '../../../src/shared/usage-request-policy'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

const PolicySettingsReplySchema = z.object({
  settings: z.object({
    usageRequestPolicyVersion: z.literal(1),
    usageRequestEnabled: z.partialRecord(z.enum(USAGE_REQUEST_PROVIDERS), z.boolean()),
    antigravityUsageEnabled: z.boolean()
  })
})

export const usageRequestSettingsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.usage-request-policy-read',
    method: 'settings.get',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('usage-request-policy', PolicySettingsReplySchema)
  })
)

export const usageRequestSettingsWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.usage-request-policy-write',
    method: 'settings.update',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('usage-request-policy', PolicySettingsReplySchema)
  })
)
