export type StatsEventType =
  | 'agent_start' // agent reported working via its hooks
  | 'agent_stop' // agent left working (done/waiting/blocked) or its pane was torn down
  | 'pr_created' // PR opened from an Orca worktree

export type StatsEvent = {
  type: StatsEventType
  at: number // Unix epoch milliseconds.
  // Keep repo/workspace context for future breakdowns even when current aggregates omit it.
  repoId?: string
  worktreeId?: string
  meta?: Record<string, string | number>
}

export type StatsAggregates = {
  totalAgentsSpawned: number
  totalPRsCreated: number
  totalAgentTimeMs: number
  // PR URLs deduplicate across restarts; collector caps this at 2000.
  countedPRs: string[]
  // Persist first event time independently: trimming the 10K event log must not move tracking-since forward.
  firstEventAt: number | null
}

export type StatsFile = {
  schemaVersion: number
  events: StatsEvent[]
  aggregates: StatsAggregates
}
