import type { EventName } from '../../shared/telemetry-events'

export function telemetryEventSampleRate(name: EventName): 0.01 | 0.001 | 1 {
  if (name === 'agent_prompt_sent') {
    return 0.01
  }
  if (name === 'daemon_audit_eligibility') {
    return 0.001
  }
  return 1
}
