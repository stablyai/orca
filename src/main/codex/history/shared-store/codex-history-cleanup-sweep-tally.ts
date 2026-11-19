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
  return { rollouts: tally(), databases: tally(), budgetHit: false }
}

const BUDGET_FILES = 500
const BUDGET_READ_BYTES = 256 * 1024 * 1024
const BUDGET_MS = 10_000

/**
 * One sweep's work in either mode: files examined, then bytes rehashed of those, and time. A file
 * starts while any is left, so one larger than the whole byte budget still gets its turn.
 */
export class CleanupBudget {
  private files = 0
  private bytes = 0
  private readonly startedAt = Date.now()

  constructor(private readonly result: CodexHistoryCleanupResult) {}

  /** Before examining another file. */
  exhausted(): boolean {
    return this.spent(this.files >= BUDGET_FILES)
  }

  /** Before rehashing one already examined. */
  readExhausted(): boolean {
    return this.spent(false)
  }

  takeFile(): void {
    this.files += 1
  }

  takeBytes(bytes: number): void {
    this.bytes += bytes
  }

  private spent(filesSpent: boolean): boolean {
    const spent =
      filesSpent || this.bytes >= BUDGET_READ_BYTES || Date.now() - this.startedAt >= BUDGET_MS
    this.result.budgetHit ||= spent
    return spent
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
