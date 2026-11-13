// Observe-only: how many /v1/assign asks per minute each requested region gets from each country,
// so the share an exclusion would remove is known before it is set. Counts only: no ids, no
// addresses. One `orca_relay_edge_region_country` line per minute with any asks.
export const EDGE_REGION_COUNTRY_EVENT = 'orca_relay_edge_region_country'
export const EDGE_REGION_COUNTRY_WINDOW_MS = 60_000
// An ask with no requested region, and one whose country is unknown.
const NO_REGION = 'none'
const UNKNOWN_COUNTRY = 'unknown'

export class EdgeRegionCountryTally {
  // region → country → asks; bounded by regions × countries.
  private counts = new Map<string, Map<string, number>>()
  private timer: ReturnType<typeof setInterval> | undefined

  record(region: string | undefined, country: string | null): void {
    const key = region ?? NO_REGION
    let byCountry = this.counts.get(key)
    if (!byCountry) {
      byCountry = new Map()
      this.counts.set(key, byCountry)
    }
    const code = country ?? UNKNOWN_COUNTRY
    byCountry.set(code, (byCountry.get(code) ?? 0) + 1)
  }

  flush(): void {
    if (this.counts.size === 0) return
    const counts: Record<string, Record<string, number>> = {}
    for (const [region, byCountry] of this.counts) counts[region] = Object.fromEntries(byCountry)
    this.counts = new Map()
    console.warn(JSON.stringify({ event: EDGE_REGION_COUNTRY_EVENT, windowMs: EDGE_REGION_COUNTRY_WINDOW_MS, counts }))
  }

  start(): void {
    this.timer ??= setInterval(() => this.flush(), EDGE_REGION_COUNTRY_WINDOW_MS)
    this.timer.unref?.()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }
}
