import type { Translate } from '../i18n/mobile-i18n'

export type HomeStatsSummary = {
  totalAgentsSpawned: number
  totalPRsCreated: number
  totalAgentTimeMs: number
}

// Wire rows and fields may be absent or malformed; the total supplies every default.
export type HomeStatsRow = Partial<Record<keyof HomeStatsSummary, unknown>> | null | undefined

const STAT_KEYS = ['totalAgentsSpawned', 'totalPRsCreated', 'totalAgentTimeMs'] as const

// Sum paired hosts only: replies outlive unpairing, and a shared slot would show whichever host replied last.
export function totalHomeStats(
  byHost: Record<string, HomeStatsRow>,
  hostIds: readonly string[]
): HomeStatsSummary | null {
  const total: HomeStatsSummary = { totalAgentsSpawned: 0, totalPRsCreated: 0, totalAgentTimeMs: 0 }
  let answered = false
  for (const hostId of hostIds) {
    const host = byHost[hostId]
    // A host without stats replies `{}`; that is no data, not a row of zeros.
    if (!host || typeof host !== 'object') {
      continue
    }
    for (const key of STAT_KEYS) {
      const value = host[key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        total[key] += value
        answered = true
      }
    }
  }
  return answered ? total : null
}

/** Whole days, else whole hours, else minutes: the tile has room for one unit. */
export function formatHomeAgentTime(ms: number, t: Translate): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) {
    return t('home.stats.days', '{{days}}d', { days })
  }
  if (hours > 0) {
    return t('home.stats.hours', '{{hours}}h', { hours })
  }
  return t('home.stats.minutes', '{{minutes}}m', { minutes })
}
