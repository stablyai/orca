import * as z from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

const AntigravityAccountStateSchema = z.looseObject({
  accounts: z.array(
    z.looseObject({
      id: z.string().min(1),
      email: z.string().nullable(),
      subject: z.string().nullable().optional()
    })
  ),
  activeAccountId: z.string().nullable(),
  // Older hosts omit `unread` and `restoresSelectionAtLaunch`.
  currentAccount: z
    .looseObject({ unread: z.literal(true).optional() })
    .nullable()
    .optional(),
  selectedAccountId: z.string().nullable(),
  restoresSelectionAtLaunch: z.literal(true).optional()
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
