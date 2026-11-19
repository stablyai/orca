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
 * abandoned. `limitTo` holds back a share of every limit, so a later phase still has some.
 */
export class CleanupBudget {
  private files = 0
  private bytes = 0
  private readonly startedAt = Date.now()
  private share = 1
  // Copies one read of which exceeds the whole byte budget: never checked, so never deleted.
  private readonly oversizedPaths = new Set<string>()
  /** Whether the budget ended the sweep's work early. */
  ranOut = false

  /** Limits the work from now on to `share` of each limit (1 lifts it). */
  limitTo(share: number): void {
    this.share = share
  }

  private get maxBytes(): number {
    return BUDGET_READ_BYTES * this.share
  }

  /** Before examining `count` more files; false once any limit is reached. */
  startFiles(count = 1): boolean {
    if (this.files + count > Math.floor(BUDGET_FILES * this.share) || this.pastDeadline()) {
      this.ranOut = true
      return false
    }
    this.files += count
    return true
  }

  /** True, and counted once per copy, when one read of `bytes` alone exceeds the whole budget. */
  skipOversized(path: string, bytes: number): boolean {
    const oversized = bytes > this.maxBytes
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
    const fits = this.bytes + bytes <= this.maxBytes && !this.pastDeadline()
    this.ranOut ||= !fits
    return fits
  }

  /** Charges bytes as they are read; throws once the bytes or the time run out. */
  read(bytes: number): void {
    this.bytes += bytes
    if (this.bytes > this.maxBytes) {
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
    const past = Date.now() >= this.startedAt + BUDGET_MS * this.share
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
