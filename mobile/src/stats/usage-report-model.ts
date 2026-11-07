// Mobile port of the desktop Stats & Usage model (src/renderer/src/components/stats/usage-provider-normalization.ts).
// Claude counts turns and splits cache read/write; Codex, OpenCode and Muse count events and report totalTokens.

export const USAGE_PROVIDERS = ['claude', 'codex', 'opencode', 'muse'] as const
export type UsageProviderId = (typeof USAGE_PROVIDERS)[number]
export type UsageScope = 'orca' | 'all'
export type UsageRange = '7d' | '30d' | '90d' | 'all'

export const USAGE_PROVIDER_LABELS: Record<UsageProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  muse: 'Muse'
}

export type UsageBreakdownRow = {
  key: string
  label: string
  sessions: number
  totalTokens: number
  costUsd: number | null
}

export type UsageSessionRow = {
  id: string
  lastActiveAt: string
  durationMinutes: number
  project: string
  model: string | null
  totalTokens: number
}

export type UsageProviderReport = {
  id: UsageProviderId
  enabled: boolean
  isScanning: boolean
  hasData: boolean
  lastScanCompletedAt: number | null
  sessions: number
  activityLabel: 'turns' | 'events'
  activityCount: number
  totalTokens: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  costUsd: number | null
  topModel: string | null
  topProject: string | null
  daily: { day: string; totalTokens: number }[]
  models: UsageBreakdownRow[]
  projects: UsageBreakdownRow[]
  recentSessions: UsageSessionRow[]
}

type LooseRow = Record<string, unknown>

function num(row: LooseRow, key: string): number {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(row: LooseRow, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' ? value : null
}

function rows(value: unknown): LooseRow[] {
  return Array.isArray(value)
    ? value.filter((row): row is LooseRow => typeof row === 'object' && row !== null)
    : []
}

function cost(row: LooseRow): number | null {
  const value = row.estimatedCostUsd
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function totalTokens(provider: UsageProviderId, row: LooseRow): number {
  if (provider === 'claude') {
    return (
      num(row, 'inputTokens') +
      num(row, 'outputTokens') +
      num(row, 'cacheReadTokens') +
      num(row, 'cacheWriteTokens')
    )
  }
  return num(row, 'totalTokens')
}

function breakdown(provider: UsageProviderId, value: unknown): UsageBreakdownRow[] {
  return rows(value).map((row) => ({
    key: str(row, 'key') ?? '',
    label: str(row, 'label') ?? '',
    sessions: num(row, 'sessions'),
    totalTokens: totalTokens(provider, row),
    costUsd: cost(row)
  }))
}

export function normalizeUsageSnapshot(
  provider: UsageProviderId,
  snapshot: unknown
): UsageProviderReport {
  const root: LooseRow =
    typeof snapshot === 'object' && snapshot !== null ? (snapshot as LooseRow) : {}
  const scan: LooseRow =
    typeof root.scanState === 'object' && root.scanState ? (root.scanState as LooseRow) : {}
  const summary: LooseRow =
    typeof root.summary === 'object' && root.summary ? (root.summary as LooseRow) : {}
  const isClaude = provider === 'claude'
  const hasDataKey = isClaude ? 'hasAnyClaudeData' : `hasAny${USAGE_PROVIDER_LABELS[provider]}Data`
  const cached = isClaude
    ? num(summary, 'cacheReadTokens') + num(summary, 'cacheWriteTokens')
    : num(summary, 'cachedInputTokens')
  return {
    id: provider,
    enabled: scan.enabled === true,
    isScanning: scan.isScanning === true,
    hasData: summary[hasDataKey] === true || scan[hasDataKey] === true,
    lastScanCompletedAt:
      typeof scan.lastScanCompletedAt === 'number' ? scan.lastScanCompletedAt : null,
    sessions: num(summary, 'sessions'),
    activityLabel: isClaude ? 'turns' : 'events',
    activityCount: num(summary, isClaude ? 'turns' : 'events'),
    totalTokens: totalTokens(provider, summary),
    // Codex-style input includes the cached subset; Claude reports them separately.
    newInputTokens: isClaude
      ? num(summary, 'inputTokens')
      : Math.max(num(summary, 'inputTokens') - cached, 0),
    outputTokens: num(summary, 'outputTokens'),
    cacheTokens: cached,
    costUsd: cost(summary),
    topModel: str(summary, 'topModel'),
    topProject: str(summary, 'topProject'),
    daily: rows(root.daily).map((row) => ({
      day: str(row, 'day') ?? '',
      totalTokens: totalTokens(provider, row)
    })),
    models: breakdown(provider, root.modelBreakdown),
    projects: breakdown(provider, root.projectBreakdown),
    recentSessions: rows(root.recentSessions).map((row) => ({
      id: str(row, 'sessionId') ?? '',
      lastActiveAt: str(row, 'lastActiveAt') ?? '',
      durationMinutes: num(row, 'durationMinutes'),
      project: str(row, 'projectLabel') ?? '',
      model: str(row, 'model'),
      totalTokens: totalTokens(provider, row)
    }))
  }
}

export type UsageOverview = {
  providers: UsageProviderReport[]
  hasAnyEnabled: boolean
  hasAnyData: boolean
  totalTokens: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  sessions: number
  activeDays: number
  costUsd: number | null
  daily: { day: string; totalTokens: number; byProvider: Record<UsageProviderId, number> }[]
  lastUpdatedAt: number | null
}

export function buildUsageOverview(
  reports: Record<UsageProviderId, UsageProviderReport>
): UsageOverview {
  const providers = USAGE_PROVIDERS.map((id) => reports[id])
  const sum = (pick: (report: UsageProviderReport) => number) =>
    providers.reduce((total, report) => total + pick(report), 0)
  const days = new Map<string, Record<UsageProviderId, number>>()
  for (const report of providers) {
    for (const point of report.daily) {
      const entry = days.get(point.day) ?? { claude: 0, codex: 0, opencode: 0, muse: 0 }
      entry[report.id] += point.totalTokens
      days.set(point.day, entry)
    }
  }
  const daily = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, byProvider]) => ({
      day,
      byProvider,
      totalTokens: USAGE_PROVIDERS.reduce((total, id) => total + byProvider[id], 0)
    }))
  const priced = providers.filter((report) => report.costUsd !== null)
  const lastUpdatedAt = providers.reduce<number | null>(
    (latest, report) =>
      report.lastScanCompletedAt && (!latest || report.lastScanCompletedAt > latest)
        ? report.lastScanCompletedAt
        : latest,
    null
  )
  return {
    providers,
    hasAnyEnabled: providers.some((report) => report.enabled),
    hasAnyData: providers.some((report) => report.hasData),
    totalTokens: sum((report) => report.totalTokens),
    newInputTokens: sum((report) => report.newInputTokens),
    outputTokens: sum((report) => report.outputTokens),
    cacheTokens: sum((report) => report.cacheTokens),
    sessions: sum((report) => report.sessions),
    activeDays: daily.filter((entry) => entry.totalTokens > 0).length,
    costUsd:
      priced.length > 0 ? priced.reduce((total, report) => total + (report.costUsd ?? 0), 0) : null,
    daily,
    lastUpdatedAt
  }
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`
  }
  return value.toLocaleString()
}

export function formatCost(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }
  return value >= 100 ? `$${Math.round(value).toLocaleString()}` : `$${value.toFixed(2)}`
}
