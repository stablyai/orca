import type { CodexHistoryCleanupSkipReason } from '../../../../shared/telemetry/schemas/telemetry-codex-history-cleanup-event-schemas'
import type { CodexHistoryCleanupKind } from '../cleanup-policy/codex-history-cleanup-policy'

/** One kind's sweep: in report mode `deleted` and `bytes` are what enforce would have deleted. */
export type CleanupKindTally = {
  candidates: number
  eligible: number
  deleted: number
  bytes: number
  skipped: Record<CodexHistoryCleanupSkipReason, number>
}

export type CodexHistoryCleanupResult = Record<CodexHistoryCleanupKind, CleanupKindTally> & {
  budgetHit: boolean
  /** A kill switch or lapsed grant stopped the sweep: its tally speaks for neither mode. */
  policyChanged: boolean
}

function emptySkips(): Record<CodexHistoryCleanupSkipReason, number> {
  return {
    changed: 0,
    hard_linked: 0,
    open: 0,
    open_unknown: 0,
    rehash_mismatch: 0,
    unshared: 0,
    not_proven_shared: 0,
    unlink_failed: 0,
    transient_capped: 0,
    oversized: 0,
    budget: 0
  }
}

export function emptyCleanupResult(): CodexHistoryCleanupResult {
  const tally = (): CleanupKindTally => ({
    candidates: 0,
    eligible: 0,
    deleted: 0,
    bytes: 0,
    skipped: emptySkips()
  })
  return { rollouts: tally(), databases: tally(), budgetHit: false, policyChanged: false }
}

const BUDGET_FILES = 500
const BUDGET_READ_BYTES = 256 * 1024 * 1024
const BUDGET_MS = 10_000

export class CleanupBudgetExceeded extends Error {}

/**
 * One sweep's work in either mode, content check included: files examined, bytes read, and time.
 * A read that would not fit what is left ends the work; one that overruns while reading is
 * abandoned.
 */
export class CleanupBudget {
  private files = 0
  private bytes = 0
  private readonly deadline = Date.now() + BUDGET_MS
  // Copies one read of which exceeds the whole byte budget: never checked, so never deleted.
  private readonly oversizedPaths = new Set<string>()
  /** Whether the budget ended the sweep's work early. */
  ranOut = false

  /** Before examining `count` more files; false once any limit is reached. */
  startFiles(count = 1): boolean {
    if (this.files + count > BUDGET_FILES || this.pastDeadline()) {
      this.ranOut = true
      return false
    }
    this.files += count
    return true
  }

  /** True, and counted once per copy, when one read of `bytes` alone exceeds the whole budget. */
  skipOversized(path: string, bytes: number): boolean {
    const oversized = bytes > BUDGET_READ_BYTES
    if (oversized) {
      this.oversizedPaths.add(path)
    }
    return oversized
  }

  get oversized(): number {
    return this.oversizedPaths.size
  }

  /** Whether reading `bytes` more fits what is left. */
  fits(bytes: number): boolean {
    const fits = this.bytes + bytes <= BUDGET_READ_BYTES && !this.pastDeadline()
    this.ranOut ||= !fits
    return fits
  }

  /** Charges bytes as they are read; throws once the bytes or the time run out. */
  read(bytes: number): void {
    this.bytes += bytes
    if (this.bytes > BUDGET_READ_BYTES) {
      this.ranOut = true
      throw new CleanupBudgetExceeded('cleanup budget reached')
    }
    this.throwIfPastDeadline()
  }

  throwIfPastDeadline(): void {
    if (this.pastDeadline()) {
      throw new CleanupBudgetExceeded('cleanup budget reached')
    }
  }

  pastDeadline(): boolean {
    const past = Date.now() >= this.deadline
    this.ranOut ||= past
    return past
  }
}

export function describeCleanupSweep(
  modes: Record<CodexHistoryCleanupKind, string>,
  result: CodexHistoryCleanupResult
): string {
  const kinds = (['rollouts', 'databases'] as const).map((kind) => {
    const tally = result[kind]
    const skipped = Object.entries(tally.skipped)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason} ${count}`)
      .join(', ')
    const verb = modes[kind] === 'enforce' ? 'deleted' : 'would delete'
    return `${kind} (${modes[kind]}): ${tally.candidates} candidates, ${tally.eligible} eligible, ${verb} ${tally.deleted} (${tally.bytes} bytes)${skipped ? `, skipped ${skipped}` : ''}`
  })
  return `${kinds.join('; ')}${result.budgetHit ? '; budget reached' : ''}`
}
