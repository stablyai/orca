import type { WorktreeShareSkipWarning } from '../../shared/worktree/create-types'

export type WorktreeConfiguredPathSkipReason =
  | 'missing'
  | 'stat-failed'
  | 'not-directory'
  | 'not-gitignored'
  | 'unsafe'
  | 'unsupported-pattern'
  | 'too-many-entries'
  | 'copy-budget'

export type WorktreeConfiguredPathSkip = {
  mechanism: 'share' | 'include'
  path: string
  reason: WorktreeConfiguredPathSkipReason
  budgetReason?: 'bytes' | 'entries' | 'sizing'
}

export type WorktreeConfiguredPathResolveResult = {
  paths: string[]
  skipped: WorktreeConfiguredPathSkip[]
}

export type WorktreeCopyBudgetSkipInput = {
  path: string
  reason: 'bytes' | 'entries' | 'sizing'
}

const SKIP_REASON_LABEL: Record<WorktreeConfiguredPathSkipReason, string> = {
  missing: 'missing',
  'stat-failed': 'unreadable',
  'not-directory': 'not a directory',
  'not-gitignored': 'not gitignored',
  unsafe: 'unsafe path',
  'unsupported-pattern': 'unsupported pattern',
  'too-many-entries': 'exceeds include entry limit',
  'copy-budget': 'exceeds copy budget'
}

// Same named-entry cap as copy-budget prose; keep RPC/JSON from listing every skip.
const MAX_NAMED_SKIPPED_ENTRIES = 5

function skippedEntryOverflowText(count: number): string | undefined {
  const rest = count - MAX_NAMED_SKIPPED_ENTRIES
  if (rest <= 0) {
    return undefined
  }
  return `and ${rest.toLocaleString('en-US')} more`
}

export function formatWorktreeConfiguredPathSkip(skip: WorktreeConfiguredPathSkip): string {
  return `${skip.mechanism}: ${skip.path} skipped (${SKIP_REASON_LABEL[skip.reason]})`
}

export function copyBudgetSkipsToConfigured(
  skipped: readonly WorktreeCopyBudgetSkipInput[]
): WorktreeConfiguredPathSkip[] {
  return skipped.map((entry) => ({
    mechanism: 'include',
    path: entry.path,
    reason: 'copy-budget',
    budgetReason: entry.reason
  }))
}

export function worktreeShareSkipWarningsFromSkips(
  skips: readonly WorktreeConfiguredPathSkip[]
): WorktreeShareSkipWarning[] {
  const named = skips.slice(0, MAX_NAMED_SKIPPED_ENTRIES)
  const warnings: WorktreeShareSkipWarning[] = named.map((skip) => ({
    code: skip.mechanism === 'share' ? 'WORKTREE_SHARE_SKIPPED' : 'WORKTREE_INCLUDE_SKIPPED',
    message: formatWorktreeConfiguredPathSkip(skip),
    details: {
      path: skip.path,
      reason: skip.reason,
      ...(skip.budgetReason ? { budgetReason: skip.budgetReason } : {})
    }
  }))
  const overflow = skippedEntryOverflowText(skips.length)
  const overflowSkip = skips[MAX_NAMED_SKIPPED_ENTRIES]
  if (overflow && overflowSkip) {
    warnings.push({
      code:
        overflowSkip.mechanism === 'share' ? 'WORKTREE_SHARE_SKIPPED' : 'WORKTREE_INCLUDE_SKIPPED',
      message: overflow
    })
  }
  return warnings
}

export function joinWorktreeShareSkipWarningText(
  skips: readonly WorktreeConfiguredPathSkip[]
): string | undefined {
  if (skips.length === 0) {
    return undefined
  }
  const lines = skips.slice(0, MAX_NAMED_SKIPPED_ENTRIES).map(formatWorktreeConfiguredPathSkip)
  const overflow = skippedEntryOverflowText(skips.length)
  if (overflow) {
    lines.push(overflow)
  }
  return lines.join('\n')
}

/** Combine resolve-time share/include skips with copy-budget refusals into the
 *  create-result `warning` string and structured `warnings` array. */
export function buildWorktreeShareSkipReport(args: {
  shareSkips: readonly WorktreeConfiguredPathSkip[]
  includeSkips: readonly WorktreeConfiguredPathSkip[]
  copySkips?: readonly WorktreeCopyBudgetSkipInput[]
  copyWarning?: string
}): {
  warning?: string
  warnings: WorktreeShareSkipWarning[]
} {
  const copyConfigured = copyBudgetSkipsToConfigured(args.copySkips ?? [])
  const warnings = worktreeShareSkipWarningsFromSkips([
    ...args.shareSkips,
    ...args.includeSkips,
    ...copyConfigured
  ])
  const resolveWarning = joinWorktreeShareSkipWarningText([
    ...args.shareSkips,
    ...args.includeSkips
  ])
  const warning = [resolveWarning, args.copyWarning]
    .filter((part): part is string => Boolean(part))
    .join('\n')
  return {
    warnings,
    ...(warning.length > 0 ? { warning } : {})
  }
}
