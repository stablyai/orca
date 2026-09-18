import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { MODEL_PRICING } from '../codex-usage/codex-model-pricing'

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const CODEX_AUTOMATION_USAGE_MAX_AGE_MS = 60_000

export function codexQuotaAvailability(
  usage: ProviderRateLimits | null,
  now: number
): 'usable' | 'exhausted' | 'unknown' {
  if (
    !usage ||
    usage.status !== 'ok' ||
    usage.error ||
    now - usage.updatedAt > CODEX_AUTOMATION_USAGE_MAX_AGE_MS ||
    usage.updatedAt > now
  ) {
    return 'unknown'
  }
  const windows = [usage.session, usage.weekly]
  if (
    windows.some(
      (window) =>
        window && window.usedPercent >= 100 && (window.resetsAt === null || window.resetsAt > now)
    )
  ) {
    return 'exhausted'
  }
  if (
    windows.some(
      (window) =>
        !window ||
        !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 ||
        window.usedPercent >= 100
    )
  ) {
    return 'unknown'
  }
  return 'usable'
}

export function selectCodexWarmupModel(models: readonly AgentSessionModelOption[]): {
  model: string
  effort: string
} | null {
  // Exact catalog IDs only: an unknown model must never inherit a cheaper alias's price.
  const priced = models.flatMap((model) => {
    const price = MODEL_PRICING[model.id]
    const effort = EFFORT_ORDER.find((value) =>
      model.efforts.some((entry) => entry.value === value)
    )
    return price && effort ? [{ model: model.id, effort, price }] : []
  })
  // A dominating price is cheapest regardless of the isolated request's actual token count.
  const cheapest = priced
    .filter((candidate) =>
      priced.every(
        (other) =>
          candidate.price.input <= other.price.input &&
          candidate.price.output <= other.price.output &&
          candidate.price.cachedInput <= other.price.cachedInput
      )
    )
    .sort((a, b) => a.model.localeCompare(b.model))[0]
  return cheapest ? { model: cheapest.model, effort: cheapest.effort } : null
}

export function isCodexQuotaFailedTurn(params: unknown): boolean {
  if (!params || typeof params !== 'object' || !('turn' in params)) {
    return false
  }
  const turn = params.turn
  if (
    !turn ||
    typeof turn !== 'object' ||
    !('status' in turn) ||
    turn.status !== 'failed' ||
    !('error' in turn)
  ) {
    return false
  }
  const error = turn.error
  return (
    !!error &&
    typeof error === 'object' &&
    'codexErrorInfo' in error &&
    error.codexErrorInfo === 'usageLimitExceeded'
  )
}
