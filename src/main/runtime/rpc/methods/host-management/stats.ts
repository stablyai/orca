import { defineMethod } from '../../core'
import { UsageSummaryParams } from '../../../../../shared/rpc-contract/usage-summary-params'

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
    name: 'usage.summary',
    permission: 'workspace',
    params: UsageSummaryParams,
    handler: async (params, { runtime }) => runtime.getHostTokenUsage(params)
  })
]
