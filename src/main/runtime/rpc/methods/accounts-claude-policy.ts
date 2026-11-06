import { defineMethod } from '../core'
import {
  RefreshClaudeAccountTokenNowParams,
  SetClaudeAccountTokenRefreshParams,
  SetClaudeAutoSwitchParams
} from '../../../../shared/rpc-contract/accounts-params'

/** Claude account policy RPCs. Kept beside accounts.ts so that file stays within the line limit. */
export const CLAUDE_ACCOUNT_POLICY_METHODS = [
  defineMethod({
    name: 'accounts.setClaudeAutoSwitch',
    permission: 'accounts-admin',
    params: SetClaudeAutoSwitchParams,
    handler: async (params, { runtime }) => runtime.setClaudeAutoSwitch(params.enabled)
  }),
  defineMethod({
    name: 'accounts.setClaudeAccountTokenRefresh',
    permission: 'accounts-admin',
    params: SetClaudeAccountTokenRefreshParams,
    handler: async (params, { runtime }) => runtime.setClaudeAccountTokenRefresh(params.enabled)
  }),
  defineMethod({
    name: 'accounts.refreshClaudeAccountTokenNow',
    permission: 'accounts-admin',
    params: RefreshClaudeAccountTokenNowParams,
    handler: async (params, { runtime }) =>
      runtime.refreshClaudeAccountTokenNow({ account: params.account, force: params.force })
  })
]
