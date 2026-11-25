// The one way any sharing path reports a failure: a closed stage and reason through track(), which
// drops it for opt-out and unofficial builds. Callers map their own errors here, never pass text.
import {
  AGENT_SHARE_CLOUD_REASONS,
  type AgentShareFailure
} from '../../shared/telemetry/schemas/telemetry-agent-share-event-schemas'
import type { ConnectorFailure } from '../connector-cloud/connector-cloud-request'
import { track } from './client'

export function reportAgentShareFailure(failure: AgentShareFailure): void {
  try {
    track('agent_share_failed', failure)
  } catch {
    // Telemetry never breaks the path it reports on.
  }
}

type CloudReason = (typeof AGENT_SHARE_CLOUD_REASONS)[number]

/** An Orca Cloud failure as a closed reason: its error code when it is one we name, else its status. */
export function agentShareCloudReason(
  failure: Pick<ConnectorFailure, 'status' | 'error'>
): CloudReason {
  const named = AGENT_SHARE_CLOUD_REASONS.find((reason) => reason === failure.error)
  if (named) {
    return named
  }
  if (failure.status === null) {
    return 'network'
  }
  if (failure.status === 429) {
    return 'rate_limited'
  }
  return failure.status >= 500 ? 'http_5xx' : 'http_4xx'
}

/** Reports a failure a poll keeps meeting once, until `clear` says it recovered. Keys stay in memory. */
export class AgentShareFailureStreaks {
  private readonly failing = new Set<string>()

  report(key: string, failure: AgentShareFailure): void {
    if (!this.failing.has(key)) {
      this.failing.add(key)
      reportAgentShareFailure(failure)
    }
  }

  clear(key: string): void {
    this.failing.delete(key)
  }
}
