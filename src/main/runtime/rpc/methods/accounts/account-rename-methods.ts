import { RenameAccountParams } from '../../../../../shared/rpc-contract/accounts-params'
import { defineMethod } from '../../core'

// Separate methods so hosts older than account names answer method_not_found, not a wrong write.
export const ACCOUNT_RENAME_METHODS = [
  defineMethod({
    name: 'accounts.renameClaude',
    permission: 'accounts-admin',
    params: RenameAccountParams,
    handler: async (params, { runtime }) =>
      runtime.renameManagedAccount('claude', params.accountId, params.displayName)
  }),
  defineMethod({
    name: 'accounts.renameCodex',
    permission: 'accounts-admin',
    params: RenameAccountParams,
    handler: async (params, { runtime }) =>
      runtime.renameManagedAccount('codex', params.accountId, params.displayName)
  })
]
