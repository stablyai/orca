import { createUsageEventAggregation } from '../usage/rollups/usage-event-aggregation'
import type { MistralVibeUsageAttributedEvent, MistralVibeUsageMetric } from './types'

export const mistralVibeUsageAggregation = createUsageEventAggregation<
  MistralVibeUsageAttributedEvent,
  MistralVibeUsageMetric
>({
  metric: {
    empty: () => ({ estimatedCostUsd: null, hasUnpricedModels: false }),
    fromEvent: (event) => ({
      estimatedCostUsd: event.estimatedCostUsd,
      hasUnpricedModels: event.hasUnpricedModels
    }),
    fold: (target, source) => {
      if (source.estimatedCostUsd !== null) {
        target.estimatedCostUsd = (target.estimatedCostUsd ?? 0) + source.estimatedCostUsd
      }
      target.hasUnpricedModels ||= source.hasUnpricedModels
    }
  },
  cloneSessionForMerge: (session) => ({
    ...session,
    locationBreakdown: session.locationBreakdown.map((entry) => ({ ...entry })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({ ...entry })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({ ...entry }))
  })
})
