import { defineMethod } from '../core'
import {
  GetUsageAnalyticsSnapshotParams,
  RefreshUsageAnalyticsParams,
  SetUsageAnalyticsEnabledParams,
  UsageAnalyticsProviderParams
} from '../../../../shared/rpc-contract/usage-analytics-params'

// Why: Settings → Stats & Usage reads token analytics from the host that ran the agents.
export const USAGE_ANALYTICS_METHODS = [
  defineMethod({
    name: 'usage.getScanState',
    permission: 'workspace',
    params: UsageAnalyticsProviderParams,
    handler: async (params, { runtime }) => runtime.getUsageAnalyticsScanState(params.provider)
  }),
  defineMethod({
    name: 'usage.setEnabled',
    permission: 'settings-write',
    params: SetUsageAnalyticsEnabledParams,
    handler: async (params, { runtime }) =>
      runtime.setUsageAnalyticsEnabled(params.provider, params.enabled)
  }),
  defineMethod({
    name: 'usage.refresh',
    permission: 'workspace',
    params: RefreshUsageAnalyticsParams,
    handler: async (params, { runtime }) =>
      runtime.refreshUsageAnalytics(params.provider, params.force ?? false)
  }),
  defineMethod({
    name: 'usage.getSnapshot',
    permission: 'workspace',
    params: GetUsageAnalyticsSnapshotParams,
    handler: async (params, { runtime }) =>
      runtime.getUsageAnalyticsSnapshot(params.provider, params.scope, params.range, params.limit)
  })
]
