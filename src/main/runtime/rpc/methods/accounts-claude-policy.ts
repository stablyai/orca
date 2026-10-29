import { defineMethod } from '../core'
import { SetClaudeAutoSwitchParams } from '../../../../shared/rpc-contract/accounts-params'

/** Claude account policy RPCs. Kept beside accounts.ts so that file stays within the line limit. */
export const CLAUDE_ACCOUNT_POLICY_METHODS = [
  defineMethod({
    name: 'accounts.setClaudeAutoSwitch',
    permission: 'accounts-admin',
    params: SetClaudeAutoSwitchParams,
    handler: async (params, { runtime }) => runtime.setClaudeAutoSwitch(params.enabled)
  })
]
