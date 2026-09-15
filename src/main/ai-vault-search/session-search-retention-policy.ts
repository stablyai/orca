import { normalizeAiVaultSearchHistoryDays } from '../../shared/ai-vault-search-settings'

const DAY_MS = 86_400_000

/** The oldest transcript mtime worth indexing; null means no bound. */
export function sessionSearchHistoryCutoffMs(
  historyDays: number | null,
  nowMs: number
): number | null {
  const days = normalizeAiVaultSearchHistoryDays(historyDays)

  return days === null ? null : nowMs - days * DAY_MS
}
