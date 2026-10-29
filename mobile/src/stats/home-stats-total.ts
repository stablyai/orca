export type HomeStatsSummary = {
  totalAgentsSpawned: number
  totalPRsCreated: number
  totalAgentTimeMs: number
  firstEventAt: number | null
}

// Sum paired hosts only: process-lifetime cached replies outlive unpairing and a shared slot would show whichever host replied last.
// Wire rows and fields may be absent or malformed; consumer guards supply all defaults.
export type HomeStatsRow = Partial<HomeStatsSummary> | null | undefined

export function totalHomeStats(
  byHost: Record<string, HomeStatsRow>,
  hostIds: readonly string[]
): HomeStatsSummary | null {
  const hosts = hostIds.filter((id) => id in byHost).map((id) => byHost[id])
  if (hosts.length === 0) {
    return null
  }
  const total: HomeStatsSummary = {
    totalAgentsSpawned: 0,
    totalPRsCreated: 0,
    totalAgentTimeMs: 0,
    firstEventAt: null
  }
  for (const host of hosts) {
    // One malformed host reply must not crash or NaN the combined usage header.
    if (!host || typeof host !== 'object') {
      continue
    }
    total.totalAgentsSpawned += finiteOrZero(host.totalAgentsSpawned)
    total.totalPRsCreated += finiteOrZero(host.totalPRsCreated)
    total.totalAgentTimeMs += finiteOrZero(host.totalAgentTimeMs)
    if (typeof host.firstEventAt === 'number' && Number.isFinite(host.firstEventAt)) {
      total.firstEventAt =
        total.firstEventAt === null
          ? host.firstEventAt
          : Math.min(total.firstEventAt, host.firstEventAt)
    }
  }
  return total
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
