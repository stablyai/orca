import type { AgentTokenUsageDaily } from '../../shared/telemetry/schemas/telemetry-agent-token-usage-schema'
import { getLocalUsageDay } from '../usage/reporting/range-query/usage-calendar-range'
import { telemetrySettings, track } from './client'

/** Days up to the one sharing was last turned on may hold usage from while it was off; they are never sent. */
export function captureAgentTokenUsageDaily(row: AgentTokenUsageDaily): boolean {
  const resumedAt = telemetrySettings()?.sharingResumedAt
  const resumedDay =
    resumedAt === undefined ? null : getLocalUsageDay(new Date(resumedAt).toISOString())
  if (resumedDay !== null && row.usage_day <= resumedDay) {
    // Accepted, so the reporter retires the day instead of retrying it.
    return true
  }
  return track('agent_token_usage_daily', row)
}
