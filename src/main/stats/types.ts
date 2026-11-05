export type StatsEventType =
  | 'agent_start' // agent reported working via its hooks
  | 'agent_stop' // agent left working (done/waiting/blocked) or its pane was torn down
  | 'pr_created' // PR opened from an Orca worktree

export type StatsEvent = {
  type: StatsEventType
  at: number // Unix epoch milliseconds.
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
  // Persisted because raw events are not retained.
  firstEventAt: number | null
}

export type StatsFile = {
  schemaVersion: number
  // Always written empty since #35544; older files may still carry events, which load ignores.
  events: StatsEvent[]
  aggregates: StatsAggregates
}
