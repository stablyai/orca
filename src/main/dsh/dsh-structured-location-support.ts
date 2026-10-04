import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { supportsCodexStructuredLocation } from '../codex/codex-structured-location-support'

export function supportsDshStructuredLocation(location: AgentSessionExecutionLocation): boolean {
  return supportsCodexStructuredLocation(location)
}
