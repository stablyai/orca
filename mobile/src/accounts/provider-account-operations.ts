import * as z from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import { ProviderRateLimitsSchema } from './accounts-snapshot'

const AntigravityAccountStateSchema = z.looseObject({
  accounts: z.array(
    z.looseObject({
      id: z.string().min(1),
      email: z.string().nullable(),
      // A usage reading this phone can't read leaves the account row without bars.
      usage: ProviderRateLimitsSchema.nullable().optional().catch(null)
    })
  ),
  activeAccountId: z.string().nullable(),
  selectedAccountId: z.string().nullable()
})

export type AntigravityAccountState = z.infer<typeof AntigravityAccountStateSchema>

export const ANTIGRAVITY_HOST_TARGET = { runtime: 'host' } as const

export const selectDataAccount = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.select-data',
    method: 'accounts.selectData',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('selected', z.unknown())
  })
)

export const listAntigravityAccounts = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.antigravity-list',
    method: 'accounts.antigravityList',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('accounts', AntigravityAccountStateSchema)
  })
)

export const selectAntigravityAccount = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'accounts.antigravity-select',
    method: 'accounts.antigravitySelect',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('selected', AntigravityAccountStateSchema)
  })
)
