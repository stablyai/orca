export type HomeStatsSummary = {
  totalAgentsSpawned: number
  totalPRsCreated: number
  totalAgentTimeMs: number
  firstEventAt: number | null
}

/**
 * Why: the home header shows one lifetime-usage row for every paired desktop. Each host answers
 * stats.summary for itself, so a single shared slot made the row flip to whichever host replied
 * last — visible churn now that every reconnect re-reads. Sum instead; one host still totals itself.
 *
 * Summing only `hostIds` keeps an unpaired desktop out of the total: replies are cached per host
 * for the life of the process, so an entry outlives the host it describes.
 */
export function totalHomeStats(
  byHost: Record<string, HomeStatsSummary>,
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
    // The rows come straight off the wire unvalidated; a malformed desktop reply must not
    // NaN out or crash the header for every other host.
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

function finiteOrZero(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
