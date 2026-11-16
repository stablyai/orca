import {
  RemoveAccountParams,
  RemoveClaudeAccountParams
} from '../../../../../shared/rpc-contract/accounts/accounts-params'
import { defineMethod } from '../../core'

// Hosts that delete a removed account's conversations lack the choice and measure methods, so
// they answer method_not_found instead of deleting what the user chose to keep.
export const CLAUDE_ACCOUNT_REMOVAL_METHODS = [
  defineMethod({
    name: 'accounts.removeClaude',
    permission: 'accounts-admin',
    params: RemoveAccountParams,
    handler: async (params, { runtime }) => runtime.removeClaudeAccount(params.accountId)
  }),
  defineMethod({
    name: 'accounts.removeClaudeWithHistoryChoice',
    permission: 'accounts-admin',
    params: RemoveClaudeAccountParams,
    handler: async (params, { runtime }) =>
      runtime.removeClaudeAccount(params.accountId, {
        deleteRetainedHistory: params.deleteRetainedHistory
      })
  }),
  defineMethod({
    name: 'accounts.measureClaudeRetainedHistory',
    permission: 'accounts-admin',
    params: RemoveAccountParams,
    handler: async (params, { runtime }) =>
      runtime.measureClaudeAccountRetainedHistory(params.accountId)
  })
]
