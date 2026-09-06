import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import type { ClaudeRuntimeAuthPreparation } from '../../claude-accounts/runtime-auth-service'
import type { ClaudeAccountSelectionTarget } from '../../claude-accounts/runtime-selection'
import type { KimiHomeResolution } from '../../kimi/kimi-runtime-home'
import type { CodexAccountSelectionTarget } from '../../codex-accounts/runtime-selection'
import type { CodexRateLimitHomeResolution } from '../../codex-accounts/runtime-home-service'

export type {
  CodexRateLimitResetResult,
  RateLimitState,
  ProviderRateLimits,
  InactiveAccountUsage,
  RateLimitRuntimeTarget
} from '../../../shared/rate-limit-types'
export type { InactiveClaudeAccountInfo } from '../claude-fetcher'
export type { ClaudeStatusLineRateLimits } from '../../../shared/claude-statusline-rate-limits'
export type { NetworkProxySettings } from '../../../shared/network-proxy'
export type { ClaudeRuntimeAuthPreparation } from '../../claude-accounts/runtime-auth-service'
export type {
  ClaudeAccountSelectionTarget,
  NormalizedClaudeAccountSelectionTarget
} from '../../claude-accounts/runtime-selection'
export { normalizeClaudeAccountSelectionTarget } from '../../claude-accounts/runtime-selection'
export type {
  CodexAccountSelectionTarget,
  NormalizedCodexAccountSelectionTarget
} from '../../codex-accounts/runtime-selection'
export { normalizeCodexAccountSelectionTarget } from '../../codex-accounts/runtime-selection'
export type { CodexRateLimitHomeResolution } from '../../codex-accounts/runtime-home-service'

export type InactiveCodexAccountInfo = {
  id: string
  resolveHome: () => { kind: 'ready'; managedHomePath: string } | { kind: 'skip' }
}

export type CodexHomePathResolver = (
  target?: CodexAccountSelectionTarget
) => CodexRateLimitHomeResolution
export type KimiHomeResolver = () => Promise<KimiHomeResolution>
export type ClaudeAuthPreparationResolver = (
  target?: ClaudeAccountSelectionTarget
) => Promise<ClaudeRuntimeAuthPreparation>

export type OpenCodeGoRateLimitConfig = {
  sessionCookie: string
  workspaceIdOverride: string
}

export type MiniMaxRateLimitConfig = {
  sessionCookie: string
  groupId: string
  models: string
}

export type MiniMaxResolvedConfig = {
  config: MiniMaxRateLimitConfig
  error: string | null
}

export type GeminiCliOAuthEnabledResolver = () => boolean
export type ActiveRateLimitProvider = ProviderRateLimits['provider']
export type ActiveProviderState = {
  provider: ActiveRateLimitProvider
  limits: ProviderRateLimits | null
}
export type ActiveWindowRefreshPlan =
  | { kind: 'none' }
  | { kind: 'full' }
  | { kind: 'providers'; providers: ActiveRateLimitProvider[] }

// Why: Claude's usage endpoint has a tight budget and quota is only informational; prefer a recent snapshot over polling into 429s.
export const DEFAULT_POLL_MS = 15 * 60 * 1000 // 15 minutes
export const MIN_POLL_MS = 30 * 1000 // 30 seconds — renderer input should never create a tight loop.
export const MAX_POLL_MS = 2_147_483_647 // Max safe setInterval delay before Node clamps back to 1ms.
export const MIN_REFETCH_MS = 5 * 60 * 1000 // 5 minutes — debounce resume/manual refresh bursts
export const ACTIVE_FAILURE_REFETCH_MS = MIN_POLL_MS
// Why: retrying a persistent failure at the 30s floor hammers endpoints into 429s; back off per failure, capped at the poll cadence.
export const MAX_ACTIVE_FAILURE_REFETCH_MS = DEFAULT_POLL_MS
export const MAX_ACTIVE_FAILURE_STREAK = 8
// Why: these providers have a dedicated fetch cycle, so an activation retry refreshes just the failing one; others force a full fetchAll.
export const INDIVIDUALLY_REFRESHABLE_PROVIDERS: ReadonlySet<ActiveRateLimitProvider> = new Set([
  'claude',
  'codex',
  'grok'
])
export const STALE_THRESHOLD_MS = 30 * 60 * 1000 // 30 minutes — after this, stale data is dropped
// Why: usage-endpoint 429 windows can outlast the generic threshold (Retry-After ~1h); quota is informational, so a stale snapshot beats a bare "Limited".
export const RATE_LIMITED_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000
// Why: statusline posts arrive on every turn; skip renderer pushes for identical windows so streaming sessions don't spam state updates.
export const LIVE_CLAUDE_INGEST_DEDUPE_MS = 30 * 1000
export const INACTIVE_FETCH_DEBOUNCE_MS = 60 * 1000 // 60 seconds — debounce fetch-on-open
// Why: each inactive Codex probe spawns a real codex process inside that
// account's live credential home; pace them out instead of bursting every
// account the moment the switcher opens.
export const INACTIVE_CODEX_PROBE_STAGGER_MS = 2_000
export const DEFERRED_STARTUP_ACTIVE_REFRESH_MS = 1000

// Why: inactive account arrays are derived from provider caches on demand in getState()/pushToRenderer().
export type InternalRateLimitState = {
  claude: ProviderRateLimits | null
  codex: ProviderRateLimits | null
  gemini: ProviderRateLimits | null
  opencodeGo: ProviderRateLimits | null
  kimi: ProviderRateLimits | null
  antigravity: ProviderRateLimits | null
  minimax: ProviderRateLimits | null
  grok: ProviderRateLimits | null
}

export function normalizePollingInterval(ms: number): number {
  if (!Number.isFinite(ms)) {
    return DEFAULT_POLL_MS
  }
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, ms))
}

export function isSystemDefaultClaudeAuth(
  authPreparation: ClaudeRuntimeAuthPreparation | undefined
): boolean {
  // Why: fetch cycles treat missing Claude auth as system-default; align the PTY gate so refresh can't trigger auth flows.
  if (!authPreparation) {
    return true
  }
  const provenance = authPreparation?.provenance
  return provenance === 'system' || Boolean(provenance?.endsWith(':system'))
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function normalizeClaudeConfigDir(dir: string | null | undefined): string | null {
  // Why: normalize mixed Windows separators for path attribution; preserve Linux case sensitivity.
  const trimmed = dir?.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return trimmed || null
}

export function delayUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function isSameUsageWindow(
  a: ProviderRateLimits['session'],
  b: ProviderRateLimits['session']
): boolean {
  if (!a || !b) {
    return a === b
  }
  return a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt
}
