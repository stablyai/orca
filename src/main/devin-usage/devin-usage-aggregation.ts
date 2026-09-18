import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import type { DevinUsageAttributedEvent, DevinUsageMetric } from './types'

export const devinUsageAggregation = createUsageEventAggregation<
  DevinUsageAttributedEvent,
  DevinUsageMetric
>({
  metric: {
    empty: () => ({}),
    fromEvent: () => ({}),
    fold: () => {}
  },
  cloneSessionForMerge: (session) => ({
    ...session,
    locationBreakdown: session.locationBreakdown.map((entry) => ({ ...entry })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({ ...entry })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({ ...entry }))
  })
})
