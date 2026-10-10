// The startup attempt's shape and limits, apart from its clock: the adapter contract reaches this
// module, so it must not pull in the host or Node-only process code.

import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'

/** A spawned child with no stdout frame or stderr line for this long has stopped starting. */
export const STRUCTURED_AGENT_SESSION_STARTUP_SILENCE_MS = 60_000
/** No start, however chatty, outlives this from its spawn. */
export const STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS = 10 * 60_000

export type StructuredAgentSessionStartupLimits = { silenceMs: number; ceilingMs: number }

export const STRUCTURED_AGENT_SESSION_STARTUP_LIMITS: StructuredAgentSessionStartupLimits = {
  silenceMs: STRUCTURED_AGENT_SESSION_STARTUP_SILENCE_MS,
  ceilingMs: STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS
}

export type StructuredAgentSessionStartupAttempt = {
  /** The host's generation for this start; never reused, even when the lease fence is. */
  readonly attemptId: string
  readonly identity: AgentSessionJournalIdentity
  readonly fence: number
  readonly spawnToken: string
  /** Where and as whom the record pins the start; an adapter never re-resolves either. */
  readonly launch: Pick<AgentSessionRecord, 'location' | 'accountHome' | 'launchDirectory'>
  /** The saved options the start launches with, as intent; never a catalog guess. */
  readonly options?: Readonly<Record<string, string>>
  /** Provider events may begin before acquisition returns. */
  readonly events?: StructuredAgentSessionEventSink
  /** Background work this start's child reports, scoped to the attempt. Unset until the host routes
   *  child work by attempt; adapters report through their registration until then. */
  readonly childWork?: (evidence: AgentChildWorkEvidence[]) => void
  /** Aborted by a close, a Stop admitted now, quit, or the startup limit: the adapter stops what it
   *  started and the acquire fails. */
  readonly signal?: AbortSignal
  /** Any stdout frame or stderr line from the child: proof the start is still moving. */
  readonly onOutput?: () => void
  /** The conversation's option revision now; a report stamps it as its read begins. */
  readonly optionRevision: () => number
}
