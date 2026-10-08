/**
 * Folds attributed usage events into per-session and per-day rollups. Shared by every
 * event-based usage provider so a token-accounting fix lands in all of them at once.
 */
import {
  indexUsageSessionBreakdowns,
  usageLocationModelKey,
  type UsageSessionBreakdownIndex
} from './usage-session-breakdown-index'
import { mergeUsageDailyAggregates, mergeUsageSessions } from './usage-rollup-merge'
import {
  usageDailyAggregateKey,
  type UsageAttributedEventFields,
  type UsageDailyAggregate,
  type UsageLocationBreakdown,
  type UsageLocationModelBreakdown,
  type UsageMetricFold,
  type UsageModelBreakdown,
  type UsageSession
} from './usage-rollup-records'

export type UsageEventAggregationOptions<TEvent, TMetric> = {
  metric: UsageMetricFold<TEvent, TMetric>
  /** Codex and OpenCode clone differently today; keep each provider's strategy explicit. */
  cloneSessionForMerge(session: UsageSession<TMetric>): UsageSession<TMetric>
}

export function createUsageEventAggregation<
  TEvent extends UsageAttributedEventFields,
  TMetric extends object
>(options: UsageEventAggregationOptions<TEvent, TMetric>) {
  const { metric, cloneSessionForMerge } = options

  function createEmptySession(event: TEvent): UsageSession<TMetric> {
    return {
      sessionId: event.sessionId,
      firstTimestamp: event.timestamp,
      lastTimestamp: event.timestamp,
      primaryModel: event.model,
      hasMixedModels: false,
      primaryProjectLabel: event.projectLabel,
      hasMixedLocations: false,
      primaryWorktreeId: event.worktreeId,
      primaryRepoId: event.repoId,
      eventCount: 0,
      totalInputTokens: 0,
      totalCachedInputTokens: 0,
      totalOutputTokens: 0,
      totalReasoningOutputTokens: 0,
      totalTokens: 0,
      ...metric.empty(),
      locationBreakdown: [],
      modelBreakdown: [],
      locationModelBreakdown: []
    }
  }

  function createEmptyDailyAggregate(event: TEvent): UsageDailyAggregate<TMetric> {
    return {
      day: event.day,
      model: event.model,
      projectKey: event.projectKey,
      projectLabel: event.projectLabel,
      repoId: event.repoId,
      worktreeId: event.worktreeId,
      eventCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      ...metric.empty()
    }
  }

  function foldLocation(
    target: UsageLocationBreakdown<TMetric>[],
    event: TEvent,
    eventMetric: TMetric,
    index: UsageSessionBreakdownIndex<TMetric>['locations']
  ): void {
    const existing = index.get(event.projectKey)
    if (existing) {
      existing.eventCount++
      existing.inputTokens += event.inputTokens
      existing.cachedInputTokens += event.cachedInputTokens
      existing.outputTokens += event.outputTokens
      existing.reasoningOutputTokens += event.reasoningOutputTokens
      existing.totalTokens += event.totalTokens
      metric.fold(existing, eventMetric)
      return
    }

    const entry: UsageLocationBreakdown<TMetric> = {
      locationKey: event.projectKey,
      projectLabel: event.projectLabel,
      repoId: event.repoId,
      worktreeId: event.worktreeId,
      eventCount: 1,
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
      reasoningOutputTokens: event.reasoningOutputTokens,
      totalTokens: event.totalTokens,
      ...eventMetric
    }
    target.push(entry)
    index.set(event.projectKey, entry)
  }

  function foldModel(
    target: UsageModelBreakdown<TMetric>[],
    event: TEvent,
    eventMetric: TMetric,
    index: UsageSessionBreakdownIndex<TMetric>['models']
  ): void {
    const key = event.model ?? 'unknown'
    const existing = index.get(key)
    if (existing) {
      existing.eventCount++
      existing.inputTokens += event.inputTokens
      existing.cachedInputTokens += event.cachedInputTokens
      existing.outputTokens += event.outputTokens
      existing.reasoningOutputTokens += event.reasoningOutputTokens
      existing.totalTokens += event.totalTokens
      metric.fold(existing, eventMetric)
      return
    }

    const entry: UsageModelBreakdown<TMetric> = {
      modelKey: key,
      modelLabel: event.model ?? 'Unknown model',
      eventCount: 1,
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
      reasoningOutputTokens: event.reasoningOutputTokens,
      totalTokens: event.totalTokens,
      ...eventMetric
    }
    target.push(entry)
    index.set(key, entry)
  }

  function foldLocationModel(
    target: UsageLocationModelBreakdown<TMetric>[],
    event: TEvent,
    eventMetric: TMetric,
    index: UsageSessionBreakdownIndex<TMetric>['locationModels']
  ): void {
    const modelKey = event.model ?? 'unknown'
    const existing = index.get(usageLocationModelKey(event.projectKey, modelKey))
    if (existing) {
      existing.eventCount++
      existing.inputTokens += event.inputTokens
      existing.cachedInputTokens += event.cachedInputTokens
      existing.outputTokens += event.outputTokens
      existing.reasoningOutputTokens += event.reasoningOutputTokens
      existing.totalTokens += event.totalTokens
      metric.fold(existing, eventMetric)
      return
    }

    const entry: UsageLocationModelBreakdown<TMetric> = {
      locationKey: event.projectKey,
      modelKey,
      modelLabel: event.model ?? 'Unknown model',
      repoId: event.repoId,
      worktreeId: event.worktreeId,
      eventCount: 1,
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
      reasoningOutputTokens: event.reasoningOutputTokens,
      totalTokens: event.totalTokens,
      ...eventMetric
    }
    target.push(entry)
    index.set(usageLocationModelKey(event.projectKey, modelKey), entry)
  }

  function finalizeSessions(
    sessionsById: Map<string, UsageSession<TMetric>>
  ): UsageSession<TMetric>[] {
    for (const session of sessionsById.values()) {
      session.locationBreakdown.sort((left, right) => right.totalTokens - left.totalTokens)
      session.modelBreakdown.sort((left, right) => right.totalTokens - left.totalTokens)
      const primaryLocation = session.locationBreakdown[0] ?? null
      const primaryModel = session.modelBreakdown[0] ?? null
      session.primaryProjectLabel =
        session.locationBreakdown.length <= 1
          ? (primaryLocation?.projectLabel ?? 'Unknown location')
          : 'Multiple locations'
      session.hasMixedLocations = session.locationBreakdown.length > 1
      session.primaryWorktreeId = primaryLocation?.worktreeId ?? null
      session.primaryRepoId = primaryLocation?.repoId ?? null
      session.primaryModel =
        session.modelBreakdown.length <= 1 ? (primaryModel?.modelLabel ?? null) : 'Mixed models'
      session.hasMixedModels = session.modelBreakdown.length > 1
    }

    return [...sessionsById.values()].sort((left, right) =>
      right.lastTimestamp.localeCompare(left.lastTimestamp)
    )
  }

  function sortDailyAggregates(
    dailyByKey: Map<string, UsageDailyAggregate<TMetric>>
  ): UsageDailyAggregate<TMetric>[] {
    return [...dailyByKey.values()].sort((left, right) =>
      left.day === right.day
        ? left.projectLabel.localeCompare(right.projectLabel)
        : left.day.localeCompare(right.day)
    )
  }

  function aggregate(events: TEvent[]): {
    sessions: UsageSession<TMetric>[]
    dailyAggregates: UsageDailyAggregate<TMetric>[]
  } {
    const sessionsById = new Map<string, UsageSession<TMetric>>()
    const dailyByKey = new Map<string, UsageDailyAggregate<TMetric>>()
    const breakdownsBySession = new Map<string, UsageSessionBreakdownIndex<TMetric>>()

    for (const event of events) {
      const eventMetric = metric.fromEvent(event)
      const session = sessionsById.get(event.sessionId) ?? createEmptySession(event)
      if (!sessionsById.has(event.sessionId)) {
        sessionsById.set(event.sessionId, session)
      }
      if (event.timestamp < session.firstTimestamp) {
        session.firstTimestamp = event.timestamp
      }
      if (event.timestamp >= session.lastTimestamp) {
        session.lastTimestamp = event.timestamp
      }
      session.eventCount++
      session.totalInputTokens += event.inputTokens
      session.totalCachedInputTokens += event.cachedInputTokens
      session.totalOutputTokens += event.outputTokens
      session.totalReasoningOutputTokens += event.reasoningOutputTokens
      session.totalTokens += event.totalTokens
      metric.fold(session, eventMetric)
      let breakdowns = breakdownsBySession.get(event.sessionId)
      if (!breakdowns) {
        breakdowns = indexUsageSessionBreakdowns(session)
        breakdownsBySession.set(event.sessionId, breakdowns)
      }
      foldLocation(session.locationBreakdown, event, eventMetric, breakdowns.locations)
      foldModel(session.modelBreakdown, event, eventMetric, breakdowns.models)
      foldLocationModel(
        session.locationModelBreakdown,
        event,
        eventMetric,
        breakdowns.locationModels
      )

      const dailyKey = usageDailyAggregateKey(event)
      const daily = dailyByKey.get(dailyKey) ?? createEmptyDailyAggregate(event)
      if (!dailyByKey.has(dailyKey)) {
        dailyByKey.set(dailyKey, daily)
      }
      daily.eventCount++
      daily.inputTokens += event.inputTokens
      daily.cachedInputTokens += event.cachedInputTokens
      daily.outputTokens += event.outputTokens
      daily.reasoningOutputTokens += event.reasoningOutputTokens
      daily.totalTokens += event.totalTokens
      metric.fold(daily, eventMetric)
    }

    return {
      sessions: finalizeSessions(sessionsById),
      dailyAggregates: sortDailyAggregates(dailyByKey)
    }
  }

  return {
    aggregate,
    finalizeSessions,
    sortDailyAggregates,
    mergeSessions: (
      target: Map<string, UsageSession<TMetric>>,
      sessions: UsageSession<TMetric>[]
    ): void => mergeUsageSessions(target, sessions, { fold: metric.fold, cloneSessionForMerge }),
    mergeDailyAggregates: (
      target: Map<string, UsageDailyAggregate<TMetric>>,
      dailyAggregates: UsageDailyAggregate<TMetric>[]
    ): void => mergeUsageDailyAggregates(target, dailyAggregates, metric.fold)
  }
}
