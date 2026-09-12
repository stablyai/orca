import type { KimiUsageSession } from './types'

function cloneSessionForMerge(session: KimiUsageSession): KimiUsageSession {
  return {
    ...session,
    locationBreakdown: session.locationBreakdown.map((entry) => ({ ...entry })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({ ...entry })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({ ...entry }))
  }
}

export function mergeSessions(
  target: Map<string, KimiUsageSession>,
  sessions: KimiUsageSession[]
): void {
  for (const session of sessions) {
    const existing = target.get(session.sessionId)
    if (!existing) {
      target.set(session.sessionId, cloneSessionForMerge(session))
      continue
    }
    mergeSessionTotals(existing, session)
    mergeSessionLocationBreakdown(existing, session)
    mergeSessionModelBreakdown(existing, session)
    mergeSessionLocationModelBreakdown(existing, session)
  }
}

function mergeSessionTotals(target: KimiUsageSession, source: KimiUsageSession): void {
  target.firstTimestamp =
    source.firstTimestamp < target.firstTimestamp ? source.firstTimestamp : target.firstTimestamp
  target.lastTimestamp =
    source.lastTimestamp > target.lastTimestamp ? source.lastTimestamp : target.lastTimestamp
  target.eventCount += source.eventCount
  target.totalInputTokens += source.totalInputTokens
  target.totalCachedInputTokens += source.totalCachedInputTokens
  target.totalCacheCreationTokens += source.totalCacheCreationTokens
  target.totalOutputTokens += source.totalOutputTokens
  target.totalTokens += source.totalTokens
}

function mergeSessionLocationBreakdown(
  target: KimiUsageSession,
  source: KimiUsageSession
): void {
  for (const location of source.locationBreakdown) {
    const existing =
      target.locationBreakdown.find((entry) => entry.locationKey === location.locationKey) ?? null
    if (existing) {
      existing.eventCount += location.eventCount
      existing.inputTokens += location.inputTokens
      existing.cachedInputTokens += location.cachedInputTokens
      existing.cacheCreationTokens += location.cacheCreationTokens
      existing.outputTokens += location.outputTokens
      existing.totalTokens += location.totalTokens
    } else {
      target.locationBreakdown.push({ ...location })
    }
  }
}

function mergeSessionModelBreakdown(target: KimiUsageSession, source: KimiUsageSession): void {
  for (const model of source.modelBreakdown) {
    const existing = target.modelBreakdown.find((entry) => entry.modelKey === model.modelKey) ?? null
    if (existing) {
      existing.eventCount += model.eventCount
      existing.inputTokens += model.inputTokens
      existing.cachedInputTokens += model.cachedInputTokens
      existing.cacheCreationTokens += model.cacheCreationTokens
      existing.outputTokens += model.outputTokens
      existing.totalTokens += model.totalTokens
    } else {
      target.modelBreakdown.push({ ...model })
    }
  }
}

function mergeSessionLocationModelBreakdown(
  target: KimiUsageSession,
  source: KimiUsageSession
): void {
  for (const locationModel of source.locationModelBreakdown) {
    const existing =
      target.locationModelBreakdown.find(
        (entry) =>
          entry.locationKey === locationModel.locationKey &&
          entry.modelKey === locationModel.modelKey
      ) ?? null
    if (existing) {
      existing.eventCount += locationModel.eventCount
      existing.inputTokens += locationModel.inputTokens
      existing.cachedInputTokens += locationModel.cachedInputTokens
      existing.cacheCreationTokens += locationModel.cacheCreationTokens
      existing.outputTokens += locationModel.outputTokens
      existing.totalTokens += locationModel.totalTokens
    } else {
      target.locationModelBreakdown.push({ ...locationModel })
    }
  }
}
