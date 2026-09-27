import type { ClaudeUsageDailyAggregate, ClaudeUsageSession } from './types'

export const SSH_USAGE_SCAN_CLAUDE_METHOD = 'usage.scanClaude' as const
// Why longer than the relay sidecar's own deadline: the sidecar must time out
// first so the host sees its error instead of a bare mux timeout.
export const SSH_USAGE_SCAN_CLAUDE_TIMEOUT_MS = 250_000
export const SSH_USAGE_SCAN_CLAUDE_PAGE_TIMEOUT_MS = 30_000
export const SSH_USAGE_SCAN_WORKTREES_MAX = 2000
export const SSH_USAGE_SCAN_FIELD_MAX_LENGTH = 4096
// Why pages: ~1k sessions of real history already serialize to ~1 MB, and relay
// responses past the bounded transport capacity are replaced by an error.
export const SSH_USAGE_SCAN_SESSIONS_PER_PAGE = 300
export const SSH_USAGE_SCAN_DAILY_PER_PAGE = 1000
export const SSH_USAGE_SCAN_PAGES_MAX = 200

export type SshUsageScanWorktree = {
  repoId: string
  worktreeId: string
  path: string
  displayName: string
}

export type SshClaudeUsageScanParams = {
  worktrees: SshUsageScanWorktree[]
  /** Absent for a fresh scan; later pages are served from that scan's result. */
  page?: { scanId: string; index: number }
}

export type SshClaudeUsageScanResult = {
  scanId: string
  pageIndex: number
  pageCount: number
  sessions: ClaudeUsageSession[]
  dailyAggregates: ClaudeUsageDailyAggregate[]
}

export function claudeUsageScanPageCount(sessionCount: number, dailyCount: number): number {
  return Math.max(
    1,
    Math.ceil(sessionCount / SSH_USAGE_SCAN_SESSIONS_PER_PAGE),
    Math.ceil(dailyCount / SSH_USAGE_SCAN_DAILY_PER_PAGE)
  )
}

export function sliceClaudeUsageScanPage<TSession, TDaily>(
  sessions: readonly TSession[],
  dailyAggregates: readonly TDaily[],
  index: number
): { sessions: TSession[]; dailyAggregates: TDaily[] } {
  return {
    sessions: sessions.slice(
      index * SSH_USAGE_SCAN_SESSIONS_PER_PAGE,
      (index + 1) * SSH_USAGE_SCAN_SESSIONS_PER_PAGE
    ),
    dailyAggregates: dailyAggregates.slice(
      index * SSH_USAGE_SCAN_DAILY_PER_PAGE,
      (index + 1) * SSH_USAGE_SCAN_DAILY_PER_PAGE
    )
  }
}

export function isUsageRelayRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SSH_USAGE_SCAN_FIELD_MAX_LENGTH
}

export function normalizeSshClaudeUsageScanParams(
  params: Record<string, unknown>
): SshClaudeUsageScanParams {
  const raw = Array.isArray(params.worktrees) ? params.worktrees : []
  const worktrees: SshUsageScanWorktree[] = []
  for (const value of raw.slice(0, SSH_USAGE_SCAN_WORKTREES_MAX)) {
    if (!isUsageRelayRecord(value)) {
      continue
    }
    const { repoId, worktreeId, path, displayName } = value
    if (
      !isBoundedString(repoId) ||
      !isBoundedString(worktreeId) ||
      !isBoundedString(path) ||
      !isBoundedString(displayName) ||
      !repoId ||
      !worktreeId ||
      !path
    ) {
      continue
    }
    worktrees.push({ repoId, worktreeId, path, displayName })
  }
  const page = isUsageRelayRecord(params.page) ? params.page : null
  const index = page?.index
  if (
    page &&
    isBoundedString(page.scanId) &&
    typeof index === 'number' &&
    Number.isSafeInteger(index) &&
    index > 0 &&
    index < SSH_USAGE_SCAN_PAGES_MAX
  ) {
    return { worktrees, page: { scanId: page.scanId, index } }
  }
  return { worktrees }
}
