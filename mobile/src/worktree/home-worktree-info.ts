/** The worktree.ps agent fields Home's rows read. */
export type HomeWorktreeAgent = {
  agentType: string | null
  state: string
  stateStartedAt: number
  parentPaneKey: string | null
}

export type HomeWorktreeSummary = {
  worktreeId: string
  repo: string
  branch: string
  displayName: string
  liveTerminalCount: number
  status?: 'working' | 'active' | 'permission' | 'done' | 'inactive'
  isActive?: boolean
  isArchived?: boolean
  lastOutputAt?: number
  lastActivityAt?: number
  agents?: HomeWorktreeAgent[]
}

export type HostWorktreeInfo = {
  hostId: string
  totalWorktrees: number
  activeCount: number
  lastActiveWorktree: HomeWorktreeSummary | null
  /** The latest rows not waiting on permission, newest first; absent in older snapshots. */
  recentWorktrees?: HomeWorktreeSummary[]
  /** Rows whose agent waits for permission or an answer. */
  permissionWorktrees?: HomeWorktreeSummary[]
  workingAgentCount?: number
  catalogUnavailable?: boolean
  // The counts are the last proven ones, kept across a failed refresh.
  staleCounts?: boolean
  // When the host last answered with these counts (ms epoch); absent in snapshots an older
  // build persisted, which is why an unstamped count counts as expired rather than fresh.
  countsProvenAt?: number
}

export const HOME_RECENT_WORKTREE_LIMIT = 3

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** When the row last did anything: the later of its activity stamp and its last output. */
export function homeWorktreeRecency(worktree: HomeWorktreeSummary): number {
  return Math.max(finiteOr(worktree.lastActivityAt, 0), finiteOr(worktree.lastOutputAt, 0))
}

/** The row's top-level agent, the one Home names and dates. */
export function homeWorktreeMainAgent(worktree: HomeWorktreeSummary): HomeWorktreeAgent | null {
  if (!Array.isArray(worktree.agents)) {
    return null
  }
  return worktree.agents.find((agent) => agent.parentPaneKey == null) ?? null
}

// Why: the lists are persisted in the Home snapshot, so keep only what the rows read.
function slimHomeWorktree(worktree: HomeWorktreeSummary): HomeWorktreeSummary {
  const agent = homeWorktreeMainAgent(worktree)
  return {
    worktreeId: worktree.worktreeId,
    repo: worktree.repo,
    branch: worktree.branch,
    displayName: worktree.displayName,
    liveTerminalCount: worktree.liveTerminalCount,
    status: worktree.status,
    isActive: worktree.isActive,
    lastOutputAt: worktree.lastOutputAt,
    lastActivityAt: worktree.lastActivityAt,
    agents: agent
      ? [
          {
            agentType: agent.agentType ?? null,
            state: agent.state,
            stateStartedAt: agent.stateStartedAt,
            parentPaneKey: null
          }
        ]
      : undefined
  }
}

/** Home's per-desktop rows from a full catalog: the recent list, the waiting list, and working agents. */
export function homeWorktreeActivity(
  worktrees: readonly HomeWorktreeSummary[]
): Pick<HostWorktreeInfo, 'recentWorktrees' | 'permissionWorktrees' | 'workingAgentCount'> {
  const live = worktrees.filter((worktree) => !worktree.isArchived)
  const permission = live.filter((worktree) => worktree.status === 'permission')
  const recent = live
    .filter((worktree) => worktree.status !== 'permission')
    .sort((a, b) => homeWorktreeRecency(b) - homeWorktreeRecency(a))
    .slice(0, HOME_RECENT_WORKTREE_LIMIT)
  let workingAgentCount = 0
  for (const worktree of live) {
    const working = Array.isArray(worktree.agents)
      ? worktree.agents.filter((agent) => agent.parentPaneKey == null && agent.state === 'working')
          .length
      : 0
    // Hosts that send no agent rows still mark the workspace itself working.
    workingAgentCount += working > 0 ? working : worktree.status === 'working' ? 1 : 0
  }
  return {
    recentWorktrees: recent.map(slimHomeWorktree),
    permissionWorktrees: permission.map(slimHomeWorktree),
    workingAgentCount
  }
}

// Why: the home snapshot is persisted across launches, so counts could otherwise be rendered as
// live while describing a workspace set proven days ago. Past this window they are only history.
export const HOME_WORKTREE_COUNTS_LIVE_MAX_AGE_MS = 10 * 60_000

export function markHomeWorktreeCatalogUnavailable(
  current: HostWorktreeInfo | undefined,
  hostId: string
): HostWorktreeInfo {
  if (current?.catalogUnavailable) {
    return current
  }
  if (current) {
    // Why: `current` predates this failure, so its counts are proven host truth — a dropped
    // socket must not erase them, only flag them as no longer live.
    return { ...current, catalogUnavailable: true, staleCounts: true }
  }
  return {
    hostId,
    totalWorktrees: 0,
    activeCount: 0,
    lastActiveWorktree: null,
    catalogUnavailable: true
  }
}

/** The host card's worktree line, or null when nothing is known yet. */
export function homeHostWorktreeSummary(
  info: HostWorktreeInfo | undefined,
  now: number = Date.now()
): string | null {
  if (!info) {
    return null
  }
  // Why (STA-3123): a catalog that never loaded must not assert a count the host has not proven.
  if (info.catalogUnavailable && !info.staleCounts) {
    return 'Worktree list unavailable'
  }
  const counts = `${info.totalWorktrees} worktree${info.totalWorktrees === 1 ? '' : 's'}${
    info.activeCount > 0 ? ` · ${info.activeCount} active` : ''
  }`
  // Age bounds liveness, not the counts themselves: a failed refresh — or a rehydrated snapshot the
  // host has not re-confirmed — is still the last thing it told us, so keep it and drop the claim
  // that it is current.
  return info.staleCounts || !provenRecently(info, now) ? `Last known: ${counts}` : counts
}

function provenRecently(info: HostWorktreeInfo, now: number): boolean {
  // A snapshot written before countsProvenAt existed has an unknowable age; treat it as expired.
  return (
    typeof info.countsProvenAt === 'number' &&
    now - info.countsProvenAt <= HOME_WORKTREE_COUNTS_LIVE_MAX_AGE_MS
  )
}
