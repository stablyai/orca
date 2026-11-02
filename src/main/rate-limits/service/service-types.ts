import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import type { ZcodePlanSite } from '../../../shared/zcode-plan-sites'
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

export type InactiveCodexHome = { kind: 'ready'; managedHomePath: string } | { kind: 'skip' }

export type InactiveCodexAccountInfo = {
  id: string
  /** May be async: a WSL home is checked before a preview reads it. */
  resolveHome: () => InactiveCodexHome | Promise<InactiveCodexHome>
}

export type CodexHomePathResolver = (
  target?: CodexAccountSelectionTarget
) => CodexRateLimitHomeResolution | Promise<CodexRateLimitHomeResolution>
export type KimiHomeResolver = () => Promise<KimiHomeResolution>
export type ClaudeAuthPreparationResolver = (
  target?: ClaudeAccountSelectionTarget
) => Promise<ClaudeRuntimeAuthPreparation>

export type OpenCodeGoRateLimitConfig = {
  sessionCookie: string
  workspaceIdOverride: string
}

export type OpenCodeGoResolvedConfig = OpenCodeGoRateLimitConfig & {
  /** Explicit Orca override; empty means fall back to OpenCode's own store and env. */
  apiKey: string
  /** Set when the saved override exists but cannot be decrypted. */
  apiKeyError: string | null
  /** Set when the saved override exists but a transient read failure skipped it this cycle. */
  apiKeyReadSkipped: boolean
}

export type MiniMaxRateLimitConfig = {
  sessionCookie: string
  groupId: string
  models: string
  endpoint: 'overseas' | 'cn'
  apiKey: string
}

export type MiniMaxResolvedConfig = {
  config: MiniMaxRateLimitConfig
  error: string | null
}

export type ZcodePlanRateLimitConfig = {
  site: ZcodePlanSite
  apiKey: string
}

export type ZcodePlanResolvedConfig = {
  config: ZcodePlanRateLimitConfig
  error: string | null
}

export type GeminiCliOAuthEnabledResolver = () => boolean

export type AntigravityUsageEnabledResolver = () => boolean
export type ActiveRateLimitProvider = ProviderRateLimits['provider']
export type ActiveProviderState = {
  provider: ActiveRateLimitProvider
  limits: ProviderRateLimits | null
}
export type ActiveWindowRefreshPlan =
  | { kind: 'none' }
  | { kind: 'full' }
  | { kind: 'providers'; providers: ActiveRateLimitProvider[] }

// Informational Claude quota has a tight endpoint budget; prefer recent snapshots to 429s.
export const DEFAULT_POLL_MS = 15 * 60 * 1000
export const MIN_POLL_MS = 30 * 1000 // Bound renderer input to avoid tight polling loops.
export const MAX_POLL_MS = 2_147_483_647 // Max safe setInterval delay before Node clamps back to 1ms.
export const MIN_REFETCH_MS = 5 * 60 * 1000
export const ACTIVE_FAILURE_REFETCH_MS = MIN_POLL_MS
// Back off persistent failures up to poll cadence instead of repeatedly hitting the 30s floor.
export const MAX_ACTIVE_FAILURE_REFETCH_MS = DEFAULT_POLL_MS
export const MAX_ACTIVE_FAILURE_STREAK = 8
// Dedicated cycles retry only the failing provider; other providers need fetchAll.
export const INDIVIDUALLY_REFRESHABLE_PROVIDERS: ReadonlySet<ActiveRateLimitProvider> = new Set([
  'claude',
  'codex',
  'grok'
])
export const STALE_THRESHOLD_MS = 30 * 60 * 1000
// 429 Retry-After and an idle Claude login's lapsed token outlast generic expiry; keep informational quota visible.
export const LONG_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000
// Deduplicate identical per-turn live posts to avoid renderer push floods.
export const LIVE_CLAUDE_INGEST_DEDUPE_MS = 30 * 1000
export const INACTIVE_FETCH_DEBOUNCE_MS = 60 * 1000
// Pace real Codex probes in live credential homes instead of bursting when the switcher opens.
export const INACTIVE_CODEX_PROBE_STAGGER_MS = 2_000
export const DEFERRED_STARTUP_ACTIVE_REFRESH_MS = 1000

// Derive inactive-account arrays from provider caches on demand.
export type InternalRateLimitState = {
  claude: ProviderRateLimits | null
  codex: ProviderRateLimits | null
  gemini: ProviderRateLimits | null
  opencodeGo: ProviderRateLimits | null
  kimi: ProviderRateLimits | null
  antigravity: ProviderRateLimits | null
  minimax: ProviderRateLimits | null
  grok: ProviderRateLimits | null
  cursor: ProviderRateLimits | null
  zcode: ProviderRateLimits | null
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
  // Missing auth is System Default; its refresh must not launch Claude auth flows.
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
  // Normalize Windows slashes for attribution while preserving Linux case sensitivity.
  const trimmed = dir?.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return trimmed || null
}
