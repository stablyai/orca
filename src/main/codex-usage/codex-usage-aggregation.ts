import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import type { CodexUsageAttributedEvent } from './types'

type CodexUsageMetric = { hasInferredPricing: boolean }

export const codexUsageAggregation = createUsageEventAggregation<
  CodexUsageAttributedEvent,
  CodexUsageMetric
>({
  metric: {
    empty: () => ({ hasInferredPricing: false }),
    fromEvent: (event) => ({ hasInferredPricing: event.hasInferredPricing }),
    fold: (target, source) => {
      target.hasInferredPricing ||= source.hasInferredPricing
    }
  },
  cloneSessionForMerge: (session) => ({
    ...session,
    locationBreakdown: session.locationBreakdown.map((entry) => ({ ...entry })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({ ...entry })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({ ...entry }))
  })
})
