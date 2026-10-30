import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import type {
  ProviderRateLimits,
  ProviderRateLimitStatus,
  RateLimitState,
  RateLimitWindow
} from '../../shared/rate-limit-types'

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
  resetsAt: number | null
}

export type AccountUsageRow = {
  agent: AccountUsageAgent
  /** Managed account id; null for the provider's system-default login. */
  accountId: string | null
  label: string | null
  active: boolean
  status: ProviderRateLimitStatus
  error: string | null
  windows: AccountUsageWindow[]
  updatedAt: number | null
}

export type AccountsUsageSnapshot = {
  claude: ClaudeRateLimitAccountsState
  codex: CodexRateLimitAccountsState
  rateLimits: RateLimitState
}

const SYSTEM_DEFAULT_LABEL = 'System default'

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
    resetsAt: window.resetsAt
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
  account: { accountId: string | null; label: string | null; active: boolean }
): AccountUsageRow {
  return {
    agent,
    ...account,
    status: limits?.status ?? 'idle',
    error: limits?.error ?? null,
    windows: limits ? usageWindows(limits) : [],
    updatedAt: limits?.updatedAt ?? null
  }
}

function managedAccountRows(
  agent: 'claude' | 'codex',
  accounts: ClaudeRateLimitAccountsState | CodexRateLimitAccountsState,
  active: ProviderRateLimits | null,
  inactive: RateLimitState['inactiveClaudeAccounts']
): AccountUsageRow[] {
  const emails = new Map<string, string>(
    accounts.accounts.map((account): [string, string] => [account.id, account.email])
  )
  const activeId = accounts.activeAccountId
  const rows: AccountUsageRow[] = []
  if (active || activeId !== null) {
    rows.push(
      row(agent, active, {
        accountId: activeId,
        label: activeId === null ? SYSTEM_DEFAULT_LABEL : (emails.get(activeId) ?? null),
        active: true
      })
    )
  }
  for (const entry of inactive) {
    if (entry.accountId === activeId) {
      continue
    }
    rows.push(
      row(agent, entry.rateLimits, {
        accountId: entry.accountId,
        label: emails.get(entry.accountId) ?? null,
        active: false
      })
    )
  }
  return rows
}

/** Flattens the host's accounts snapshot into one usage row per agent account. */
export function buildAccountUsageRows(snapshot: AccountsUsageSnapshot): AccountUsageRow[] {
  const { rateLimits } = snapshot
  const rows: AccountUsageRow[] = [
    ...managedAccountRows(
      'claude',
      snapshot.claude,
      rateLimits.claude,
      rateLimits.inactiveClaudeAccounts
    ),
    ...managedAccountRows(
      'codex',
      snapshot.codex,
      rateLimits.codex,
      rateLimits.inactiveCodexAccounts
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
      rows.push(row(limits.provider, limits, { accountId: null, label: null, active: true }))
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
    : `${percent} (resets in ${formatDuration(window.resetsAt - now)})`
}

function hasUsage(row: AccountUsageRow): boolean {
  return row.windows.length > 0
}

function formatRow(row: AccountUsageRow, labelWidth: number, now: number): string {
  const label = `${row.label ?? ''}${row.active && row.label !== null ? ' (active)' : ''}`
  const usage = hasUsage(row)
    ? row.windows.map((window) => formatWindow(window, now)).join('  ')
    : (row.error ?? 'No usage data (try --fresh)')
  const stale = hasUsage(row) && row.error ? `  [stale: ${row.error}]` : ''
  return `  ${label.padEnd(labelWidth)}${labelWidth > 0 ? '  ' : ''}${usage}${stale}`
}

/** Renders usage rows grouped by agent; agents with no usage collapse into one footer block. */
export function formatAccountUsage(rows: readonly AccountUsageRow[], now: number): string {
  const blocks: string[] = []
  const unavailable: string[] = []
  for (const agent of ACCOUNT_USAGE_AGENTS) {
    const agentRows = rows.filter((entry) => entry.agent === agent)
    if (agentRows.length === 0) {
      continue
    }
    const shown = agentRows.filter(
      (entry) => hasUsage(entry) || (entry.label !== null && entry.status !== 'unavailable')
    )
    if (shown.length === 0) {
      const reason = agentRows.find((entry) => entry.error)?.error
      unavailable.push(`  ${AGENT_LABELS[agent]}${reason ? `: ${reason}` : ''}`)
      continue
    }
    const labelWidth = Math.max(
      ...shown.map((entry) => (entry.label ?? '').length + (entry.active && entry.label ? 9 : 0))
    )
    blocks.push(
      [AGENT_LABELS[agent], ...shown.map((entry) => formatRow(entry, labelWidth, now))].join('\n')
    )
  }
  if (unavailable.length > 0) {
    blocks.push(['No usage', ...unavailable].join('\n'))
  }
  return blocks.length > 0 ? blocks.join('\n\n') : 'No agent usage reported.'
}
