import { defineMethod } from '../../core'
import { StatsUsageParams } from '../../../../../shared/rpc-contract/host-management/stats-usage-params'

export const STATS_METHODS = [
  defineMethod({
    name: 'stats.summary',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => {
      return runtime.getStatsSummary() ?? {}
    }
  }),
  defineMethod({
    name: 'stats.usage',
    permission: 'workspace',
    params: StatsUsageParams,
    handler: async ({ provider, scope, range, sessions }, { runtime }) => ({
      provider,
      snapshot: await runtime.getUsageSnapshot(provider, { scope, range, limit: sessions })
    })
  })
]
