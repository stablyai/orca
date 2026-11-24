import type { AgentTokenUsageDaily } from '../../shared/telemetry/schemas/telemetry-agent-token-usage-schema'
import { telemetrySettings, track } from './client'
import { isBeforeSharingResumed } from './consent'

export function captureAgentTokenUsageDaily(row: AgentTokenUsageDaily): boolean {
  if (isBeforeSharingResumed(telemetrySettings(), row.usage_day)) {
    // Accepted, so the reporter retires the day instead of retrying it.
    return true
  }
  return track('agent_token_usage_daily', row)
}
