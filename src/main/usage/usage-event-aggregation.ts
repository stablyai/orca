/**
 * Folds attributed usage events into per-session and per-day rollups. Shared by every
 * event-based usage provider so a token-accounting fix lands in all of them at once.
 */
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
    eventMetric: TMetric
  ): void {
    const existing = target.find((entry) => entry.locationKey === event.projectKey) ?? null
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

    target.push({
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
    })
  }

  function foldModel(
    target: UsageModelBreakdown<TMetric>[],
    event: TEvent,
    eventMetric: TMetric
  ): void {
    const key = event.model ?? 'unknown'
    const existing = target.find((entry) => entry.modelKey === key) ?? null
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

    target.push({
      modelKey: key,
      modelLabel: event.model ?? 'Unknown model',
      eventCount: 1,
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
      reasoningOutputTokens: event.reasoningOutputTokens,
      totalTokens: event.totalTokens,
      ...eventMetric
    })
  }

  function foldLocationModel(
    target: UsageLocationModelBreakdown<TMetric>[],
    event: TEvent,
    eventMetric: TMetric
  ): void {
    const modelKey = event.model ?? 'unknown'
    const existing =
      target.find(
        (entry) => entry.locationKey === event.projectKey && entry.modelKey === modelKey
      ) ?? null
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

    target.push({
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
    })
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
      foldLocation(session.locationBreakdown, event, eventMetric)
      foldModel(session.modelBreakdown, event, eventMetric)
      foldLocationModel(session.locationModelBreakdown, event, eventMetric)

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
