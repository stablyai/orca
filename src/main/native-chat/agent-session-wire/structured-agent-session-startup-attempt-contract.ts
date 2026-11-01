// Adapter-reachable contract must remain free of host and Node-only process dependencies.

import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionRecord,
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity
} from '../../../shared/agent-session-record'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { AgentChatPermissionChoice } from '../../../shared/agent-chat-permission-mode'

/** Absolute registration-time ceiling, independent of shorter protocol-step bounds. */
export const STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS = 10 * 60_000

export type StructuredAgentSessionStartupLimits = { ceilingMs: number }

export const STRUCTURED_AGENT_SESSION_STARTUP_LIMITS: StructuredAgentSessionStartupLimits = {
  ceilingMs: STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS
}

export type StructuredAgentSessionStartupAttempt = {
  /** Unique even when a lease fence is reused. */
  readonly attemptId: string
  readonly identity: AgentSessionJournalIdentity
  readonly fence: number
  readonly spawnToken: string
  /** Pinned launch identity/location; adapters must not re-resolve. */
  readonly launch: Pick<AgentSessionRecord, 'location' | 'accountHome' | 'launchDirectory'>
  /** Saved launch intent, never catalog guesses. */
  readonly options?: Readonly<Record<string, string>>
  readonly permissionMode?: AgentChatPermissionChoice
  /** Provider events may begin before spawn returns. */
  readonly events?: StructuredAgentSessionEventSink
  /** Attempt-scoped background evidence; adapters use registration reporting when absent. */
  readonly childWork?: (evidence: AgentChildWorkEvidence[]) => void
  /** Stop/close/quit/expiry requires adapter cleanup and failed spawn. */
  readonly signal?: AbortSignal
}

export class StructuredAgentSessionStartupExpiredError extends Error {
  constructor() {
    super('the agent stopped making progress before it finished starting')
    this.name = 'StructuredAgentSessionStartupExpiredError'
  }
}

export function isStructuredAgentSessionStartupExpired(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'StructuredAgentSessionStartupExpiredError'
}

export type StructuredAgentSessionAcquisitionReceipt = Pick<
  StructuredAgentSessionStartupAttempt,
  'attemptId' | 'fence' | 'spawnToken'
> & {
  location: AgentSessionExecutionLocation
  process?: AgentSessionProcessIdentity
}
