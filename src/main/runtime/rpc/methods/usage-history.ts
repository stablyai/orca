import {
  UsageRefreshParams,
  UsageSetEnabledParams,
  UsageSnapshotParams
} from '../../../../shared/rpc-contract/usage-history-params'
import { defineMethod } from '../core'

export const USAGE_HISTORY_METHODS = [
  defineMethod({
    name: 'usage.getSnapshot',
    permission: 'workspace',
    params: UsageSnapshotParams,
    handler: async ({ provider, ...query }, { runtime }) =>
      runtime.usageHistory.getSnapshot(provider, query)
  }),
  defineMethod({
    name: 'usage.refresh',
    permission: 'workspace',
    params: UsageRefreshParams,
    handler: async ({ provider, force }, { runtime }) =>
      runtime.usageHistory.refresh(provider, force)
  }),
  defineMethod({
    name: 'usage.setEnabled',
    permission: 'settings-write',
    params: UsageSetEnabledParams,
    handler: async ({ provider, enabled }, { runtime }) =>
      runtime.usageHistory.setEnabled(provider, enabled)
  })
]
