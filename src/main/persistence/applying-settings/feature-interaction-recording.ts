import type { PersistedState } from '../../../shared/persisted-state-types'
import type { StoreOwnedPersistedState } from '../loading-store/store-owned-state'
import {
  compareFeatureInteractionUsageBuckets,
  getFeatureInteractionCategory,
  getFeatureInteractionUsageBucket,
  normalizeFeatureInteractions,
  normalizeFeatureInteractionTelemetryBuckets,
  type FeatureInteractionId
} from '../../../shared/feature-interactions'
import { track } from '../../telemetry/client'
import { getCohortAtEmit } from '../../telemetry/cohort-classifier'

export type FeatureInteractionOperations = {
  state: StoreOwnedPersistedState
  scheduleSave: () => void
  notifyUIChanged: () => void
  getUI: () => PersistedState['ui']
}

export function recordFeatureInteraction(
  operations: FeatureInteractionOperations,
  id: FeatureInteractionId
): PersistedState['ui'] {
  const featureInteractions = normalizeFeatureInteractions(operations.state.ui?.featureInteractions)
  const telemetryBuckets = normalizeFeatureInteractionTelemetryBuckets(
    operations.state.featureInteractionTelemetryBuckets
  )
  const existing = featureInteractions[id]
  const previousCount = existing?.interactionCount ?? 0
  const nextCount = previousCount + 1
  const previousBucket = getFeatureInteractionUsageBucket(previousCount)
  const nextBucket = getFeatureInteractionUsageBucket(nextCount)
  const lastEmittedBucket = telemetryBuckets[id] ?? null
  const shouldEmit =
    nextBucket !== null &&
    (lastEmittedBucket === null ||
      compareFeatureInteractionUsageBuckets(nextBucket, lastEmittedBucket) > 0)

  operations.state.ui = {
    ...operations.state.ui,
    featureInteractions: {
      ...featureInteractions,
      [id]: {
        firstInteractedAt: existing?.firstInteractedAt ?? Date.now(),
        interactionCount: nextCount
      }
    }
  }
  operations.state.featureInteractionTelemetryBuckets = shouldEmit
    ? { ...telemetryBuckets, [id]: nextBucket }
    : telemetryBuckets
  operations.scheduleSave()
  // Why: live UI only consumes the seen transition; count-only telemetry must not re-hydrate the renderer.
  if (!existing) {
    operations.notifyUIChanged()
  }

  if (shouldEmit) {
    track('feature_interaction_usage_bucket_reached', {
      feature_id: id,
      feature_category: getFeatureInteractionCategory(id),
      count_bucket: nextBucket,
      bucket_source:
        lastEmittedBucket === null && previousBucket !== null && previousBucket === nextBucket
          ? 'observed_existing'
          : 'crossed_now',
      ...getCohortAtEmit()
    })
  }
  return operations.getUI()
}
