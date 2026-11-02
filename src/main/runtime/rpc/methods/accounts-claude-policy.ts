import { defineMethod } from '../core'
import {
  AssignClaudePaneParams,
  ClaudeAuthProxyStatusParams,
  SetClaudeAuthProxyParams,
  SetClaudeAutoSwitchParams,
  SetClaudeSessionMoverParams
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
    name: 'accounts.setClaudeAuthProxy',
    permission: 'accounts-admin',
    params: SetClaudeAuthProxyParams,
    handler: async (params, { runtime }) => runtime.setClaudeAuthProxy(params.enabled)
  }),
  defineMethod({
    name: 'accounts.claudeAuthProxyStatus',
    permission: 'accounts-admin',
    params: ClaudeAuthProxyStatusParams,
    handler: async (_params, { runtime }) => runtime.claudeAuthProxyStatus()
  }),
  defineMethod({
    name: 'accounts.assignClaudePane',
    permission: 'accounts-admin',
    params: AssignClaudePaneParams,
    handler: async (params, { runtime }) => runtime.assignClaudePane(params)
  }),
  defineMethod({
    name: 'accounts.setClaudeSessionMover',
    permission: 'accounts-admin',
    params: SetClaudeSessionMoverParams,
    handler: async (params, { runtime }) => runtime.setClaudeSessionMover(params.setting)
  })
]
