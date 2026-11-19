import {
  CODEX_HISTORY_CLEANUP_SKIP_REASONS,
  type CodexHistoryCleanupSkipReason
} from '../../../../shared/telemetry/schemas/telemetry-codex-history-cleanup-event-schemas'
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

export function emptyCleanupResult(): CodexHistoryCleanupResult {
  const tally = (): CleanupKindTally => ({
    candidates: 0,
    eligible: 0,
    deleted: 0,
    bytes: 0,
    skipped: Object.fromEntries(
      CODEX_HISTORY_CLEANUP_SKIP_REASONS.map((reason) => [reason, 0])
    ) as Record<CodexHistoryCleanupSkipReason, number>
  })
  return { rollouts: tally(), databases: tally(), budgetHit: false, policyChanged: false }
}

const BUDGET_FILES = 500
const BUDGET_READ_BYTES = 256 * 1024 * 1024
const BUDGET_MS = 10_000

export class CleanupBudgetExceeded extends Error {}

/**
 * One sweep's work in either mode, content check included: files examined, bytes read, and time.
 * A read that would not fit what is left is skipped; one that overruns while reading is abandoned.
 */
export class CleanupBudget {
  private files = 0
  private bytes = 0
  private readonly deadline = Date.now() + BUDGET_MS
  private skippedLarge = false
  /** Whether the budget ended the sweep's work early. */
  ranOut = false

  /** Whether the budget left anything undone, a file too large for what was left included. */
  get hit(): boolean {
    return this.ranOut || this.skippedLarge
  }

  /** Before examining `count` more files; false once any limit is reached. */
  startFiles(count = 1): boolean {
    if (this.files >= BUDGET_FILES || this.pastDeadline()) {
      this.ranOut = true
      return false
    }
    this.files += count
    return true
  }

  /** Whether reading `bytes` more fits what is left; one that doesn't is skipped, not started. */
  fits(bytes: number): boolean {
    const fits = this.bytes + bytes <= BUDGET_READ_BYTES && !this.pastDeadline()
    this.skippedLarge ||= !fits
    return fits
  }

  /** Charges bytes as they are read; throws once the bytes or the time run out. */
  read(bytes: number): void {
    this.bytes += bytes
    if (this.bytes > BUDGET_READ_BYTES || this.pastDeadline()) {
      this.ranOut = true
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
