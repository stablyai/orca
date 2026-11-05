import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import type { CodexLongContextTokens, CodexUsageAttributedEvent } from './types'

type CodexUsageMetric = { hasInferredPricing: boolean } & CodexLongContextTokens

export const codexUsageAggregation = createUsageEventAggregation<
  CodexUsageAttributedEvent,
  CodexUsageMetric
>({
  metric: {
    empty: () => ({
      hasInferredPricing: false,
      longContextInputTokens: 0,
      longContextCachedInputTokens: 0,
      longContextOutputTokens: 0
    }),
    fromEvent: (event) => ({
      hasInferredPricing: event.hasInferredPricing,
      longContextInputTokens: event.longContextInputTokens,
      longContextCachedInputTokens: event.longContextCachedInputTokens,
      longContextOutputTokens: event.longContextOutputTokens
    }),
    fold: (target, source) => {
      target.hasInferredPricing ||= source.hasInferredPricing
      target.longContextInputTokens += source.longContextInputTokens
      target.longContextCachedInputTokens += source.longContextCachedInputTokens
      target.longContextOutputTokens += source.longContextOutputTokens
    }
  },
  cloneSessionForMerge: (session) => ({
    ...session,
    locationBreakdown: session.locationBreakdown.map((entry) => ({ ...entry })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({ ...entry })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({ ...entry }))
  })
})
