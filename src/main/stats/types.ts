// ─── Stats Event Log ────────────────────────────────────────────────

export type StatsEventType =
  | 'agent_start' // agent PTY detected via OSC title
  | 'agent_stop' // agent PTY exited or went idle
  | 'pr_created' // PR opened from an Orca worktree

export type StatsEvent = {
  type: StatsEventType
  at: number // Date.now() timestamp
  // Optional context for future per-repo/per-worktree breakdowns.
  // Not used for v1 aggregation but captured now to avoid retrofitting.
  repoId?: string
  worktreeId?: string
  meta?: Record<string, string | number>
  // meta examples:
  //   agent_start:  { ptyId: '42' }
  //   agent_stop:   { ptyId: '42', durationMs: 185000 }
  //   pr_created:   { prNumber: 123 }
}

// ─── Pre-computed Aggregates ────────────────────────────────────────

export type StatsAggregates = {
  totalAgentsSpawned: number
  totalPRsCreated: number
  totalAgentTimeMs: number
  // Set of PR URLs already counted, to deduplicate across restarts.
  // Bounded in practice (a few hundred at most).
  countedPRs: string[]
  // Why persisted here instead of derived from events[0].at:
  // The event log is bounded to 10K entries. Once trimmed, events[0].at
  // would jump forward, making "tracking since..." inaccurate. This field
  // is set once on the very first event and never updated.
  firstEventAt: number | null
}

// ─── Persisted File Shape ───────────────────────────────────────────

export type StatsFile = {
  schemaVersion: number
  events: StatsEvent[]
  aggregates: StatsAggregates
}
