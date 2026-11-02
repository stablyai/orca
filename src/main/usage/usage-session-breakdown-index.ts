import type {
  UsageSession,
  UsageLocationBreakdown,
  UsageModelBreakdown,
  UsageLocationModelBreakdown
} from './usage-rollup-records'

export function usageLocationModelKey(locationKey: string, modelKey: string): string {
  return JSON.stringify([locationKey, modelKey])
}

export function indexUsageSessionBreakdowns<TMetric>(session: UsageSession<TMetric>) {
  const locations = new Map<string, UsageLocationBreakdown<TMetric>>()
  const models = new Map<string, UsageModelBreakdown<TMetric>>()
  const locationModels = new Map<string, UsageLocationModelBreakdown<TMetric>>()
  for (const entry of session.locationBreakdown) {
    if (!locations.has(entry.locationKey)) {
      locations.set(entry.locationKey, entry)
    }
  }
  for (const entry of session.modelBreakdown) {
    if (!models.has(entry.modelKey)) {
      models.set(entry.modelKey, entry)
    }
  }
  for (const entry of session.locationModelBreakdown) {
    const key = usageLocationModelKey(entry.locationKey, entry.modelKey)
    if (!locationModels.has(key)) {
      locationModels.set(key, entry)
    }
  }
  return { locations, models, locationModels }
}

export type UsageSessionBreakdownIndex<TMetric> = ReturnType<
  typeof indexUsageSessionBreakdowns<TMetric>
>
