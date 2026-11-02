import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget,
  RateLimitState,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import { getSelectedClaudeAccountIdForTarget } from '../../main/claude-accounts/runtime-selection'
import { getSelectedCodexAccountIdForTarget } from '../../main/codex-accounts/runtime-selection'

export type AccountUsageAgent = ProviderRateLimits['provider']

export const ACCOUNT_USAGE_AGENTS: readonly AccountUsageAgent[] = [
  'claude',
  'codex',
  'gemini',
  'opencode-go',
  'kimi',
  'antigravity',
  'minimax',
  'grok',
  'cursor',
  'zcode'
]

const AGENT_LABELS: Record<AccountUsageAgent, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  'opencode-go': 'OpenCode Go',
  kimi: 'Kimi Code',
  antigravity: 'Antigravity',
  minimax: 'MiniMax',
  grok: 'Grok',
  cursor: 'Cursor',
  zcode: 'ZCode'
}

export type AccountUsageWindow = {
  name: string
  usedPercent: number
  windowMinutes: number
  resetsAt: string | null
}

export type AccountUsageRow = {
  agent: AccountUsageAgent
  /** Managed account id; null for the provider's system-default login. */
  accountId: string | null
  label: string | null
  active: boolean
  status: 'ok' | 'unavailable'
  /** Why usage is unavailable; on an ok row, the last refresh failure behind stale windows. */
  error: string | null
  windows: AccountUsageWindow[]
  updatedAt: string | null
}

export type AccountsUsageSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
  rateLimits: RateLimitState
}

const SYSTEM_DEFAULT_LABEL = 'System default'
const NOT_READ_YET = 'No usage read yet; run with --fresh.'
// The host skips an unselected-account read within a minute of the last one, so --fresh can still leave a row unread.
const NOT_READ_AFTER_FRESH =
  'No usage read yet; Orca reads unselected accounts at most once a minute, so try again shortly.'
const BEING_READ = 'Usage is still being read; try again shortly.'

function isoTime(ms: number | null | undefined): string | null {
  return ms ? new Date(ms).toISOString() : null
}

function windowName(minutes: number): string {
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}d`
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`
  }
  return `${minutes}m`
}

function toWindow(name: string, window: RateLimitWindow): AccountUsageWindow {
  return {
    name,
    usedPercent: window.usedPercent,
    windowMinutes: window.windowMinutes,
    resetsAt: isoTime(window.resetsAt)
  }
}

function usageWindows(limits: ProviderRateLimits): AccountUsageWindow[] {
  const windows: AccountUsageWindow[] = []
  for (const window of [limits.session, limits.weekly, limits.monthly]) {
    if (window) {
      windows.push(toWindow(windowName(window.windowMinutes), window))
    }
  }
  if (limits.fableWeekly) {
    windows.push(
      toWindow(`fable ${windowName(limits.fableWeekly.windowMinutes)}`, limits.fableWeekly)
    )
  }
  // Why: buckets usually restate session/weekly; only per-model pools have nothing else to show.
  if (windows.length === 0) {
    for (const bucket of limits.buckets ?? []) {
      windows.push(toWindow(bucket.name, bucket))
    }
  }
  return windows
}

function row(
  agent: AccountUsageAgent,
  limits: ProviderRateLimits | null,
  account: { accountId: string | null; label: string | null; active: boolean },
  missingReason: string
): AccountUsageRow {
  const windows = limits ? usageWindows(limits) : []
  const reason = limits?.status === 'fetching' ? BEING_READ : missingReason
  return {
    agent,
    ...account,
    status: windows.length > 0 ? 'ok' : 'unavailable',
    error: limits?.error ?? (windows.length > 0 ? null : reason),
    windows,
    updatedAt: isoTime(limits?.updatedAt)
  }
}

function targetLabel(target: RateLimitRuntimeTarget): string {
  return target.runtime === 'host' ? 'host' : `WSL ${target.wslDistro ?? 'default distro'}`
}

/** One row per managed account, so accounts whose usage was never read still show up. */
function managedAccountRows(
  agent: 'claude' | 'codex',
  accounts: ClaudeRateLimitAccountsState | CodexRateLimitAccountsState,
  targetAccountId: string | null,
  target: RateLimitRuntimeTarget,
  active: ProviderRateLimits | null,
  inactive: RateLimitState['inactiveClaudeAccounts'],
  notReadYet: string
): AccountUsageRow[] {
  const selectedIds = new Set([
    accounts.activeAccountId,
    accounts.activeAccountIdsByRuntime?.host,
    ...Object.values(accounts.activeAccountIdsByRuntime?.wsl ?? {})
  ])
  const cached = new Map(inactive.map((entry) => [entry.accountId, entry]))
  const rows: AccountUsageRow[] = []
  if (targetAccountId === null && active) {
    rows.push(
      row(
        agent,
        active,
        { accountId: null, label: SYSTEM_DEFAULT_LABEL, active: true },
        NOT_READ_YET
      )
    )
  }
  for (const account of accounts.accounts) {
    const identity = { accountId: account.id, label: account.email }
    if (account.id === targetAccountId) {
      rows.push(row(agent, active, { ...identity, active: true }, NOT_READ_YET))
      continue
    }
    const entry = cached.get(account.id)
    // Orca reads usage for the rate-limit target's selection and for unselected accounts only.
    const missingReason = selectedIds.has(account.id)
      ? `Selected on another runtime; Orca reads usage for the ${targetLabel(target)} selection only.`
      : entry?.isFetching
        ? BEING_READ
        : notReadYet
    rows.push(
      row(
        agent,
        entry?.rateLimits ?? null,
        { ...identity, active: selectedIds.has(account.id) },
        missingReason
      )
    )
  }
  return rows
}

/** Flattens the host's accounts snapshot into one usage row per agent account. */
export function buildAccountUsageRows(
  snapshot: AccountsUsageSnapshot,
  { fresh = false }: { fresh?: boolean } = {}
): AccountUsageRow[] {
  const { claude, codex, rateLimits } = snapshot
  const notReadYet = fresh ? NOT_READ_AFTER_FRESH : NOT_READ_YET
  // The active usage snapshot belongs to the account selected for the rate-limit target, which may be a WSL distro.
  const claudeTargetAccountId = getSelectedClaudeAccountIdForTarget(
    {
      activeClaudeManagedAccountId: claude.activeAccountId,
      activeClaudeManagedAccountIdsByRuntime: claude.activeAccountIdsByRuntime
    },
    rateLimits.claudeTarget
  )
  const codexTargetAccountId = getSelectedCodexAccountIdForTarget(
    {
      activeCodexManagedAccountId: codex.activeAccountId,
      activeCodexManagedAccountIdsByRuntime: codex.activeAccountIdsByRuntime
    },
    rateLimits.codexTarget
  )
  const rows: AccountUsageRow[] = [
    ...managedAccountRows(
      'claude',
      claude,
      claudeTargetAccountId,
      rateLimits.claudeTarget,
      rateLimits.claude,
      rateLimits.inactiveClaudeAccounts,
      notReadYet
    ),
    ...managedAccountRows(
      'codex',
      codex,
      codexTargetAccountId,
      rateLimits.codexTarget,
      rateLimits.codex,
      rateLimits.inactiveCodexAccounts,
      notReadYet
    )
  ]
  const singleAccountProviders = [
    rateLimits.gemini,
    rateLimits.opencodeGo,
    rateLimits.kimi,
    rateLimits.antigravity,
    rateLimits.minimax,
    rateLimits.grok,
    rateLimits.cursor,
    rateLimits.zcode
  ]
  for (const limits of singleAccountProviders) {
    if (limits) {
      rows.push(
        row(
          limits.provider,
          limits,
          { accountId: null, label: null, active: true },
          'No usage reported.'
        )
      )
    }
  }
  return rows
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) {
    return `${days}d ${hours}h`
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`
  }
  return `${minutes}m`
}

function formatWindow(window: AccountUsageWindow, now: number): string {
  const percent = `${window.name} ${Math.round(window.usedPercent)}%`
  return window.resetsAt === null
    ? percent
    : `${percent} (resets in ${formatDuration(Date.parse(window.resetsAt) - now)})`
}

function formatRow(row: AccountUsageRow, labelWidth: number, now: number): string {
  const label = `${row.label ?? ''}${row.active && row.label !== null ? ' (active)' : ''}`
  const usage =
    row.status === 'ok'
      ? row.windows.map((window) => formatWindow(window, now)).join('  ')
      : row.error
  const stale = row.status === 'ok' && row.error ? `  [stale: ${row.error}]` : ''
  return `  ${label.padEnd(labelWidth)}${labelWidth > 0 ? '  ' : ''}${usage}${stale}`
}

/** Renders usage rows grouped by agent; agents with neither usage nor managed accounts collapse into one footer. */
export function formatAccountUsage(rows: readonly AccountUsageRow[], now: number): string {
  const blocks: string[] = []
  const unavailable: string[] = []
  for (const agent of ACCOUNT_USAGE_AGENTS) {
    const agentRows = rows.filter((entry) => entry.agent === agent)
    if (agentRows.length === 0) {
      continue
    }
    if (agentRows.every((entry) => entry.status === 'unavailable' && entry.accountId === null)) {
      const reason = agentRows.find((entry) => entry.error)?.error
      unavailable.push(`  ${AGENT_LABELS[agent]}${reason ? `: ${reason}` : ''}`)
      continue
    }
    const labelWidth = Math.max(
      ...agentRows.map(
        (entry) => (entry.label ?? '').length + (entry.active && entry.label ? 9 : 0)
      )
    )
    blocks.push(
      [AGENT_LABELS[agent], ...agentRows.map((entry) => formatRow(entry, labelWidth, now))].join(
        '\n'
      )
    )
  }
  if (unavailable.length > 0) {
    blocks.push(['No usage', ...unavailable].join('\n'))
  }
  return blocks.length > 0 ? blocks.join('\n\n') : 'No agent usage reported.'
}
