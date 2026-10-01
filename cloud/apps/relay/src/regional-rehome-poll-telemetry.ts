// A gated poll and a poll that simply found nobody to move both produce zero
// candidates and no attempt row, so an operator watching a stalled rollout
// cannot tell them apart. One aggregated line a minute per director names the
// gate and prices the selection, at a rate a 50-polls-a-minute worker can afford.
export type RegionalRehomePollGate =
  | 'open'
  | 'cohort-zero'
  | 'process-safety-unavailable'
  | 'control-closed'
  | 'budget-closed'
  | 'fleet-safety'

export const REGIONAL_REHOME_POLL_SUMMARY_INTERVAL_MS = 60_000

const EMPTY_GATES: Record<RegionalRehomePollGate, number> = {
  open: 0,
  'cohort-zero': 0,
  'process-safety-unavailable': 0,
  'control-closed': 0,
  'budget-closed': 0,
  'fleet-safety': 0
}

export class RegionalRehomePollTelemetry {
  private windowStartedAt: number | null = null
  private gates = { ...EMPTY_GATES }
  private candidates = 0
  private selectionSamplesMs: number[] = []
  private skippedOffRegionSourceCellsMax = 0

  constructor(private readonly write: (line: string) => void = (line) => console.warn(line)) {}

  record(input: {
    now: number
    gate: RegionalRehomePollGate
    candidates: number
    selectionMs?: number
    skippedOffRegionSourceCells?: number
  }): void {
    if (this.windowStartedAt === null) this.windowStartedAt = input.now
    this.gates[input.gate] += 1
    this.candidates += input.candidates
    if (input.selectionMs !== undefined) this.selectionSamplesMs.push(input.selectionMs)
    this.skippedOffRegionSourceCellsMax = Math.max(
      this.skippedOffRegionSourceCellsMax,
      input.skippedOffRegionSourceCells ?? 0
    )
    if (input.now - this.windowStartedAt < REGIONAL_REHOME_POLL_SUMMARY_INTERVAL_MS) return
    this.write(
      JSON.stringify({
        event: 'orca_relay_regional_rehome_poll_summary',
        windowMs: input.now - this.windowStartedAt,
        polls: Object.values(this.gates).reduce((total, count) => total + count, 0),
        ...this.gates,
        candidates: this.candidates,
        selectionMsMax: round(Math.max(0, ...this.selectionSamplesMs)),
        selectionMsP95: round(percentile(this.selectionSamplesMs, 0.95)),
        // A per-poll maximum: every poll reads the same inventory, so a sum counts polls.
        skippedOffRegionSourceCells: this.skippedOffRegionSourceCellsMax
      })
    )
    this.windowStartedAt = input.now
    this.gates = { ...EMPTY_GATES }
    this.candidates = 0
    this.selectionSamplesMs = []
    this.skippedOffRegionSourceCellsMax = 0
  }
}

function percentile(samples: number[], fraction: number): number {
  if (!samples.length) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
