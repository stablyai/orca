import {
  RemoveAccountParams,
  RemoveClaudeAccountParams
} from '../../../../../shared/rpc-contract/accounts/accounts-params'
import { defineMethod } from '../../core'

// A separate measure method so hosts that still delete everything answer method_not_found.
export const CLAUDE_ACCOUNT_REMOVAL_METHODS = [
  defineMethod({
    name: 'accounts.removeClaude',
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
