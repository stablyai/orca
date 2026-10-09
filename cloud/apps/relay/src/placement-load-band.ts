// Spreads placement over cells near the minimum load, so a freshly rolled
// (empty) cell does not take a whole drain and serialize every follow-up on
// its one relay_cells row. It only orders candidates: a candidate is never
// refused, and the pool's least-loaded cell is the fallback.

// Cells within this share of capacity of the least-loaded one are equals.
export const PLACEMENT_LOAD_BAND = 0.05
// A minute, so a director at the 1,200 s drain pace (~0.5 picks/s) still
// holds enough picks for the share, not the floor, to decide.
export const PLACEMENT_INTAKE_WINDOW_MS = 60_000
// A cell over this share of its pool's recent placements yields to the rest.
export const PLACEMENT_INTAKE_SHARE = 0.4
// Below this many recent picks a cell is never skipped, so quiet traffic
// still goes to the least-loaded cell.
export const PLACEMENT_INTAKE_FLOOR = 2
export const PLACEMENT_LOAD_BAND_SUMMARY_MS = 60_000

export type LoadBandCandidate = { cellId: string; loadRatio: number }

type LoadBandSummary = {
  picks: number
  // Picks where at least one candidate was over budget and skipped.
  budgetSkips: number
  // Picks where every candidate was over budget: the least-loaded cell took it.
  fallbacks: number
  bandSizeTotal: number
  bandSizeMax: number
  picksByCell: Record<string, number>
}

function emptySummary(): LoadBandSummary {
  return {
    picks: 0,
    budgetSkips: 0,
    fallbacks: 0,
    bandSizeTotal: 0,
    bandSizeMax: 0,
    picksByCell: {}
  }
}

export class PlacementLoadBand {
  // Director-instance-local and in memory: it shapes order, never correctness.
  private readonly intake = new Map<string, number[]>()
  private summary = emptySummary()
  private summaryStartedAt: number | undefined

  constructor(
    private readonly random: () => number = Math.random,
    private readonly log: (line: string) => void = (line) => console.info(line)
  ) {}

  // `sorted` is ascending by load ratio. Records the pick as intake; a pick
  // whose transaction retries counts again, which only spreads harder.
  pick<T extends LoadBandCandidate>(sorted: readonly T[], now: number): T | undefined {
    const least = sorted[0]
    if (!least) return undefined
    const recent = new Map(
      sorted.map((candidate) => [candidate.cellId, this.recentIntake(candidate.cellId, now)])
    )
    let poolIntake = 0
    for (const count of recent.values()) poolIntake += count
    const budget = Math.max(PLACEMENT_INTAKE_FLOOR, PLACEMENT_INTAKE_SHARE * poolIntake)
    const withinBudget = sorted.filter((candidate) => (recent.get(candidate.cellId) ?? 0) < budget)
    const pool = withinBudget.length > 0 ? withinBudget : [least]
    const ceiling = pool[0]!.loadRatio + PLACEMENT_LOAD_BAND
    const band = pool.filter((candidate) => candidate.loadRatio <= ceiling)
    const picked = band[Math.min(band.length - 1, Math.floor(this.random() * band.length))]!
    this.record(picked.cellId, now)
    this.observe(now, {
      cellId: picked.cellId,
      skipped: withinBudget.length < sorted.length,
      fallback: withinBudget.length === 0,
      bandSize: band.length
    })
    return picked
  }

  // One line a minute tells a spread drain from a floor- or fallback-dominated one.
  private observe(
    now: number,
    pick: { cellId: string; skipped: boolean; fallback: boolean; bandSize: number }
  ): void {
    this.summaryStartedAt ??= now
    const summary = this.summary
    summary.picks += 1
    if (pick.skipped) summary.budgetSkips += 1
    if (pick.fallback) summary.fallbacks += 1
    summary.bandSizeTotal += pick.bandSize
    summary.bandSizeMax = Math.max(summary.bandSizeMax, pick.bandSize)
    summary.picksByCell[pick.cellId] = (summary.picksByCell[pick.cellId] ?? 0) + 1
    if (now - this.summaryStartedAt < PLACEMENT_LOAD_BAND_SUMMARY_MS) return
    this.log(
      JSON.stringify({
        event: 'orca_relay_placement_load_band',
        windowMs: now - this.summaryStartedAt,
        ...summary
      })
    )
    this.summary = emptySummary()
    this.summaryStartedAt = now
  }

  private recentIntake(cellId: string, now: number): number {
    const times = this.intake.get(cellId)
    if (!times) return 0
    const cutoff = now - PLACEMENT_INTAKE_WINDOW_MS
    let expired = 0
    while (expired < times.length && times[expired]! <= cutoff) expired += 1
    if (expired > 0) times.splice(0, expired)
    if (times.length === 0) this.intake.delete(cellId)
    return times.length
  }

  private record(cellId: string, now: number): void {
    const times = this.intake.get(cellId)
    if (times) times.push(now)
    else this.intake.set(cellId, [now])
  }
}
