// Why: keep these shapes in lockstep with src/shared/types.ts and
// src/shared/rate-limit-types.ts. We don't import from desktop here because
// the mobile bundle must not pull in Electron-coupled type files.
//
// Pure state/selectors live here (no React Native imports) so they can be
// unit-tested directly; AccountUsage.tsx re-exports them alongside the
// UsageBar component.
export type RateLimitWindow = {
  usedPercent: number
  windowMinutes: number
  resetsAt: number | null
  resetDescription: string | null
}

export type ProviderRateLimits = {
  provider: 'claude' | 'codex' | 'gemini' | 'opencode-go' | 'kimi' | 'minimax' | 'grok'
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  monthly?: RateLimitWindow | null
  buckets?: Array<RateLimitWindow & { name: string }>
  updatedAt: number
  error: string | null
  status: 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable'
}

export type InactiveAccountUsage = {
  accountId: string
  rateLimits: ProviderRateLimits | null
  updatedAt: number
  isFetching: boolean
}

export type ClaudeAccountSummary = {
  id: string
  email: string
  organizationName?: string | null
}

export type CodexAccountSummary = {
  id: string
  email: string
  workspaceLabel?: string | null
}

// Why: the host sends the full RateLimitState in every snapshot, so the extra
// providers' data already arrives on the phone. The new fields are optional so
// an old cached snapshot (home-snapshot-cache v1) that predates them stays a
// valid value — selectors normalize a missing field to null via `?? null`.
export type AccountsSnapshot = {
  claude: { accounts: ClaudeAccountSummary[]; activeAccountId: string | null }
  codex: { accounts: CodexAccountSummary[]; activeAccountId: string | null }
  rateLimits: {
    claude: ProviderRateLimits | null
    codex: ProviderRateLimits | null
    gemini?: ProviderRateLimits | null
    opencodeGo?: ProviderRateLimits | null
    kimi?: ProviderRateLimits | null
    minimax?: ProviderRateLimits | null
    grok?: ProviderRateLimits | null
    inactiveClaudeAccounts: InactiveAccountUsage[]
    inactiveCodexAccounts: InactiveAccountUsage[]
  }
}

// Why: only Claude and Codex have Orca-managed accounts and interactive
// switching (add/re-auth stays desktop-only). Everything else is display-only
// usage, so account-switching selectors accept only this narrow type — a
// display-only provider can never route to accounts.selectClaude/selectCodex.
export type ManagedAccountProviderKey = 'claude' | 'codex'
export type UsageProviderKey =
  | ManagedAccountProviderKey
  | 'gemini'
  | 'opencode-go'
  | 'kimi'
  | 'minimax'
  | 'grok'

// Kept as an alias so existing switching call sites stay constrained to the
// two managed providers.
export type ProviderKey = ManagedAccountProviderKey

// The snapshot rateLimits field a provider's usage lives under. Distinct from
// the wire id: OpenCode Go's id is 'opencode-go' but its field is 'opencodeGo'.
type ProviderSnapshotField =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencodeGo'
  | 'kimi'
  | 'minimax'
  | 'grok'

export type UsageProviderDescriptor = {
  id: UsageProviderKey
  label: string
  snapshotField: ProviderSnapshotField
  managed: boolean
}

// Single source that maps the stable preference/wire id to its snapshot field,
// label, and whether it supports account switching. Drives iteration order,
// visibility toggles, and field lookup.
export const USAGE_PROVIDERS: readonly UsageProviderDescriptor[] = [
  { id: 'claude', label: 'Claude', snapshotField: 'claude', managed: true },
  { id: 'codex', label: 'Codex', snapshotField: 'codex', managed: true },
  { id: 'gemini', label: 'Gemini', snapshotField: 'gemini', managed: false },
  { id: 'opencode-go', label: 'OpenCode Go', snapshotField: 'opencodeGo', managed: false },
  { id: 'kimi', label: 'Kimi', snapshotField: 'kimi', managed: false },
  { id: 'minimax', label: 'MiniMax', snapshotField: 'minimax', managed: false },
  { id: 'grok', label: 'Grok', snapshotField: 'grok', managed: false }
]

export const USAGE_PROVIDER_IDS: readonly UsageProviderKey[] = USAGE_PROVIDERS.map((p) => p.id)

// Providers shown by default when the user has never opened the filter — the
// two primary agents, matching the phone's historical behavior and the rule
// that the phone must not surface every provider at once.
export const DEFAULT_VISIBLE_USAGE_PROVIDERS: readonly UsageProviderKey[] = ['claude', 'codex']

export function getUsageProviderDescriptor(
  provider: UsageProviderKey
): UsageProviderDescriptor | null {
  return USAGE_PROVIDERS.find((p) => p.id === provider) ?? null
}

export type UsageBarState = {
  usedPercent: number | null
  unavailable: boolean
  loading: boolean
}

export function getActiveProviderRateLimits(
  snapshot: AccountsSnapshot,
  provider: UsageProviderKey
): ProviderRateLimits | null {
  const field = getUsageProviderDescriptor(provider)?.snapshotField
  if (!field) {
    return null
  }
  // `?? null` normalizes a field missing from an old cached snapshot.
  return snapshot.rateLimits[field] ?? null
}

export function getInactiveProviderUsage(
  snapshot: AccountsSnapshot,
  provider: ManagedAccountProviderKey,
  accountId: string
): InactiveAccountUsage | null {
  const list =
    provider === 'claude'
      ? snapshot.rateLimits.inactiveClaudeAccounts
      : snapshot.rateLimits.inactiveCodexAccounts
  return list.find((u) => u.accountId === accountId) ?? null
}

// Why: rate limits are fetched for the active target even when no Orca-managed
// account exists (the default target is the agent's own system-default login).
// Treat a provider as having usage worth showing when a fetch succeeded or any
// window has data; an unavailable/error provider with no windows means the
// system-default login has no credentials for it, so there is nothing to show.
export function hasActiveProviderUsage(limits: ProviderRateLimits | null): boolean {
  if (!limits) {
    return false
  }
  if (
    limits.session != null ||
    limits.weekly != null ||
    limits.monthly != null ||
    (limits.buckets && limits.buckets.length > 0)
  ) {
    return true
  }
  return limits.status === 'ok'
}

// Why: transient errors keep the last successful window data, so availability
// is per window rather than per provider status.
export function getUsageBarState(
  limits: ProviderRateLimits | null,
  windowKey: 'session' | 'weekly',
  isFetchingOverride?: boolean
): UsageBarState {
  const window = limits?.[windowKey] ?? null
  const fetching =
    isFetchingOverride ?? (limits?.status === 'fetching' || limits?.status === 'idle')
  return {
    usedPercent: window?.usedPercent ?? null,
    unavailable: window == null && !fetching,
    loading: fetching && window == null
  }
}

export type UsageWindowRow = {
  key: string
  label: string
  usedPercent: number
}

// Why: providers do not share one fixed pair of windows. Gemini reports named
// per-model buckets, OpenCode Go reports a monthly window, others report
// session (5h) / weekly (7d). Return the labelled rows a provider actually has
// so display-only sections render each provider's real usage instead of two
// hardcoded 5h/7d bars that would show dashes for buckets/monthly.
export function getProviderUsageWindows(limits: ProviderRateLimits | null): UsageWindowRow[] {
  if (!limits) {
    return []
  }
  const buckets = limits.buckets ?? []
  // Why: when named buckets exist they are authoritative. Gemini's `session`
  // is derived from the most-constrained bucket (host deriveSessionSummary), so
  // emitting both would show that worst bucket twice under a false "5h" label.
  // Key includes the index so two buckets with the same name stay distinct.
  if (buckets.length > 0) {
    return buckets.map((bucket, index) => ({
      key: `bucket:${index}:${bucket.name}`,
      label: bucket.name,
      usedPercent: bucket.usedPercent
    }))
  }
  const rows: UsageWindowRow[] = []
  if (limits.session) {
    rows.push({ key: 'session', label: '5h', usedPercent: limits.session.usedPercent })
  }
  if (limits.weekly) {
    rows.push({ key: 'weekly', label: '7d', usedPercent: limits.weekly.usedPercent })
  }
  if (limits.monthly) {
    rows.push({ key: 'monthly', label: '30d', usedPercent: limits.monthly.usedPercent })
  }
  return rows
}

// Why: the usage UI must render for the system-default login, not only for
// Orca-managed accounts. Show a provider when it has at least one managed
// account OR active rate-limit data for the system-default target.
export function hasRenderableUsage(
  snapshot: AccountsSnapshot,
  provider: UsageProviderKey
): boolean {
  const descriptor = getUsageProviderDescriptor(provider)
  if (descriptor?.managed) {
    const accounts = provider === 'claude' ? snapshot.claude.accounts : snapshot.codex.accounts
    if (accounts.length > 0) {
      return true
    }
  }
  return hasActiveProviderUsage(getActiveProviderRateLimits(snapshot, provider))
}
