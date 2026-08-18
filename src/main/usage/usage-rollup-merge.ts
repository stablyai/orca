/** Combines rollups produced by separate sources (rollout files, sibling databases) of one provider. */
import {
  usageDailyAggregateKey,
  type UsageDailyAggregate,
  type UsageMetricFold,
  type UsageSession
} from './usage-rollup-records'

export type UsageRollupMergeOptions<TMetric> = {
  fold: UsageMetricFold<never, TMetric>['fold']
  cloneSessionForMerge(session: UsageSession<TMetric>): UsageSession<TMetric>
}

export function mergeUsageSessions<TMetric extends object>(
  target: Map<string, UsageSession<TMetric>>,
  sessions: UsageSession<TMetric>[],
  { fold, cloneSessionForMerge }: UsageRollupMergeOptions<TMetric>
): void {
  for (const session of sessions) {
    const existing = target.get(session.sessionId)
    if (!existing) {
      target.set(session.sessionId, cloneSessionForMerge(session))
      continue
    }

    existing.firstTimestamp =
      session.firstTimestamp < existing.firstTimestamp
        ? session.firstTimestamp
        : existing.firstTimestamp
    existing.lastTimestamp =
      session.lastTimestamp > existing.lastTimestamp
        ? session.lastTimestamp
        : existing.lastTimestamp
    existing.eventCount += session.eventCount
    existing.totalInputTokens += session.totalInputTokens
    existing.totalCachedInputTokens += session.totalCachedInputTokens
    existing.totalOutputTokens += session.totalOutputTokens
    existing.totalReasoningOutputTokens += session.totalReasoningOutputTokens
    existing.totalTokens += session.totalTokens
    fold(existing, session)

    for (const location of session.locationBreakdown) {
      const existingLocation =
        existing.locationBreakdown.find((entry) => entry.locationKey === location.locationKey) ??
        null
      if (existingLocation) {
        existingLocation.eventCount += location.eventCount
        existingLocation.inputTokens += location.inputTokens
        existingLocation.cachedInputTokens += location.cachedInputTokens
        existingLocation.outputTokens += location.outputTokens
        existingLocation.reasoningOutputTokens += location.reasoningOutputTokens
        existingLocation.totalTokens += location.totalTokens
        fold(existingLocation, location)
      } else {
        existing.locationBreakdown.push({ ...location })
      }
    }

    for (const model of session.modelBreakdown) {
      const existingModel =
        existing.modelBreakdown.find((entry) => entry.modelKey === model.modelKey) ?? null
      if (existingModel) {
        existingModel.eventCount += model.eventCount
        existingModel.inputTokens += model.inputTokens
        existingModel.cachedInputTokens += model.cachedInputTokens
        existingModel.outputTokens += model.outputTokens
        existingModel.reasoningOutputTokens += model.reasoningOutputTokens
        existingModel.totalTokens += model.totalTokens
        fold(existingModel, model)
      } else {
        existing.modelBreakdown.push({ ...model })
      }
    }

    for (const locationModel of session.locationModelBreakdown) {
      const existingLocationModel =
        existing.locationModelBreakdown.find(
          (entry) =>
            entry.locationKey === locationModel.locationKey &&
            entry.modelKey === locationModel.modelKey
        ) ?? null
      if (existingLocationModel) {
        existingLocationModel.eventCount += locationModel.eventCount
        existingLocationModel.inputTokens += locationModel.inputTokens
        existingLocationModel.cachedInputTokens += locationModel.cachedInputTokens
        existingLocationModel.outputTokens += locationModel.outputTokens
        existingLocationModel.reasoningOutputTokens += locationModel.reasoningOutputTokens
        existingLocationModel.totalTokens += locationModel.totalTokens
        fold(existingLocationModel, locationModel)
      } else {
        existing.locationModelBreakdown.push({ ...locationModel })
      }
    }
  }
}

export function mergeUsageDailyAggregates<TMetric extends object>(
  target: Map<string, UsageDailyAggregate<TMetric>>,
  dailyAggregates: UsageDailyAggregate<TMetric>[],
  fold: UsageMetricFold<never, TMetric>['fold']
): void {
  for (const aggregate of dailyAggregates) {
    const key = usageDailyAggregateKey(aggregate)
    const existing = target.get(key)
    if (!existing) {
      target.set(key, { ...aggregate })
      continue
    }
    existing.eventCount += aggregate.eventCount
    existing.inputTokens += aggregate.inputTokens
    existing.cachedInputTokens += aggregate.cachedInputTokens
    existing.outputTokens += aggregate.outputTokens
    existing.reasoningOutputTokens += aggregate.reasoningOutputTokens
    existing.totalTokens += aggregate.totalTokens
    fold(existing, aggregate)
  }
}
