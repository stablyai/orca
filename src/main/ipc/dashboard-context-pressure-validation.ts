import { AGENT_CONTEXT_USAGE_MAX_TOKENS } from '../../shared/agent-context-pressure'

// Dashboard snapshots may emit every traffic-light level.
const DASHBOARD_CONTEXT_PRESSURE_LEVELS = new Set(['ok', 'warning', 'critical'])
const DASHBOARD_CONTEXT_PRESSURE_LIMIT_SOURCES = new Set(['provider', 'model', 'soft-cap'])
const DASHBOARD_CONTEXT_USAGE_SOURCES = new Set(['provider', 'derived-percent'])

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Optional context-pressure field on a dashboard card: absent or a fully
 *  populated, bounded reading. */
export function isDashboardContextPressure(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const pressure = value as Record<string, unknown>
  return (
    typeof pressure.level === 'string' &&
    DASHBOARD_CONTEXT_PRESSURE_LEVELS.has(pressure.level) &&
    isFiniteNumber(pressure.usedPercent) &&
    pressure.usedPercent >= 0 &&
    pressure.usedPercent <= 100 &&
    isFiniteNumber(pressure.usedTokens) &&
    Number.isInteger(pressure.usedTokens) &&
    pressure.usedTokens >= 0 &&
    pressure.usedTokens <= AGENT_CONTEXT_USAGE_MAX_TOKENS &&
    isFiniteNumber(pressure.limitTokens) &&
    Number.isInteger(pressure.limitTokens) &&
    pressure.limitTokens >= 1 &&
    pressure.limitTokens <= AGENT_CONTEXT_USAGE_MAX_TOKENS &&
    typeof pressure.limitSource === 'string' &&
    DASHBOARD_CONTEXT_PRESSURE_LIMIT_SOURCES.has(pressure.limitSource) &&
    (pressure.usedTokensSource === undefined ||
      (typeof pressure.usedTokensSource === 'string' &&
        DASHBOARD_CONTEXT_USAGE_SOURCES.has(pressure.usedTokensSource)))
  )
}
