import type { AgentTokenUsageDaily } from '../../shared/telemetry/schemas/telemetry-agent-token-usage-schema'
import { shiftDay } from '../usage/reporting/range-query/usage-calendar-range'
import { telemetrySettings, track } from './client'

/** Days up to the one sharing last turned back on may hold usage from while it was off; they are never sent. */
export function captureAgentTokenUsageDaily(row: AgentTokenUsageDaily): boolean {
  const resumedDay = telemetrySettings()?.sharingResumedDay
  // Rows use the current time zone's days, so a later zone change can shift that usage one day later.
  if (resumedDay !== undefined && row.usage_day <= shiftDay(resumedDay, 1)) {
    // Accepted, so the reporter retires the day instead of retrying it.
    return true
  }
  return track('agent_token_usage_daily', row)
}
