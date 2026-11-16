import { defineMethod } from '../../core'
import {
  QueryClaudeResetCreditsParams,
  ConsumeClaudeResetCreditParams
} from '../../../../../shared/rpc-contract/accounts/accounts-params'

export const CLAUDE_RESET_CREDIT_METHODS = [
  defineMethod({
    name: 'accounts.queryClaudeResetCredits',
    permission: 'accounts-admin',
    params: QueryClaudeResetCreditsParams,
    handler: async (params, { runtime }) =>
      runtime.getClaudeResetCredits().queryResetCredits(params.account, params.requestId)
  }),
  defineMethod({
    name: 'accounts.consumeClaudeResetCredit',
    permission: 'accounts-admin',
    params: ConsumeClaudeResetCreditParams,
    handler: async (params, { runtime }) => {
      const result = await runtime.getClaudeResetCredits().consumeResetCredit(params)
      // Refresh the current selection without moving the meter back to an outgoing account.
      void runtime
        .getUsageRateLimits()
        ?.refresh()
        .catch(() => {})
      return result
    }
  })
]
