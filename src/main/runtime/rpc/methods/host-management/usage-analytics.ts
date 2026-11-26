import { defineMethod } from '../../core'
import { UsageCallParams } from '../../../../../shared/backend/backend-service-contract'
import { invokeHostUsageAnalytics } from '../../../../usage/host-usage-analytics'

// The host that holds the agent transcripts computes their usage; clients only read it.
export const USAGE_ANALYTICS_METHODS = [
  defineMethod({
    name: 'usage.call',
    permission: 'workspace',
    params: UsageCallParams,
    handler: async (params) => invokeHostUsageAnalytics(params)
  })
]
