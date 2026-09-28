// Which durable teardown witnesses are still offers.
//
// The marker IS the answer to "was this chat working" AND the description of what it was doing:
// teardown took both from the same check the sidebar shows, right before the chat's child was
// stopped. Nothing here re-reads the journal to second-guess it — once reattached, a provider
// rewrites that journal in its own words (a notice turn of its own, restated subagent rows, a
// restored thread), and every reading of those rewrites as "the work is done" dropped chats that
// were owed a resume.
//
// An offer ends when the chat moves on after the restart — another message accepted, or its agent
// started — or when the conversation forked. Both are reported back as `superseded` so the caller
// DELETES the record rather than filtering it forever. What remains are structural checks that are not about work at all: the record still
// exists and this build supports it, and the lease is free.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleRoot
} from '../../../shared/agent-session-provider-handle'
import type {
  AgentSessionResumeFailureOutcome,
  AgentSessionResumeMarker,
  AgentSessionResumeTrigger,
  AgentSessionResumeWork
} from '../../../shared/agent-session-resume-marker'
import type { AgentSessionRestartActivity } from '../../../shared/agent-session-restart-activity'
import { isResumableStructuredAgentSessionRecord } from './structured-agent-session-resume-eligibility'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'

export type StructuredAgentSessionResumeCandidate = {
  sessionId: string
  workspaceId: string
  agent: AgentSessionRecord['provider']
  work: AgentSessionResumeWork
  trigger: AgentSessionResumeTrigger
  recordedAt: number
  /** The prompt the row quotes, so the user recognises the chat before resuming it. */
  latestPrompt: string
  /** Which machine ran it, so the offer carries the same host badge the sidebar shows. */
  executionHostId: AgentSessionRecord['location']['executionHostId']
  /** Git worktree or folder workspace — the surface picks its glyph from this, never from a name. */
  workspaceKind: AgentSessionRecord['location']['workspaceKind']
  /** Model in force, read from the record's acknowledged options exactly as the status feed does.
   *  Absent until the host has read them. */
  model?: string
  /** What the chat was doing, from the marker's own stop-time snapshot. Optional on the wire: an
   *  older host omits it, and so does a marker from a build that recorded no snapshot. */
  activity?: AgentSessionRestartActivity
}

/** An offer that was acted on and did not end with the agent carrying on. Same row shape as the
 *  candidate so one surface renders both, plus what went wrong and when. */
export type StructuredAgentSessionResumeFailure = StructuredAgentSessionResumeCandidate & {
  failedAt: number
  outcome: AgentSessionResumeFailureOutcome
  /** The host's or provider's refusal code, verbatim, so it can be quoted in a report. */
  reason: string
  /** Whether naming it in an action would run it again: whether it is still an offer. A
   *  continuation the chat already holds, or the user having moved on, makes a retry a no-op no
   *  matter what the reason says. */
  retryable: boolean
}

export type StructuredAgentSessionResumableSet = {
  candidates: StructuredAgentSessionResumeCandidate[]
  /** Markers the chat has provably moved past, or whose conversation forked. Every ending deletes:
   *  the caller retires these rather than re-filtering them forever. */
  superseded: AgentSessionResumeMarker[]
}

export type StructuredAgentSessionResumeSetInput = {
  markers: readonly AgentSessionResumeMarker[]
  getRecord: (sessionId: string) => AgentSessionRecord | null
  supportsRecord: (record: AgentSessionRecord) => boolean
  latestPrompt: (sessionId: string) => string
  /** Whether the chat moved on since the offer was taken; false when its journal is not open here. */
  movedOn: (marker: AgentSessionResumeMarker) => boolean
  /**
   * Whether the lease must be free.
   *
   * `may-be-held` is used for ONE thing: deciding whether a session whose own pane already
   * re-acquired it may be settled as resumed. Every other clause still applies — relaxing this one
   * must never become a way to act on a marker the rest of the predicate rejected.
   */
  leaseState?: 'must-be-released' | 'may-be-held'
}

export function structuredAgentSessionResumableSet(
  input: StructuredAgentSessionResumeSetInput
): StructuredAgentSessionResumableSet {
  const candidates: StructuredAgentSessionResumeCandidate[] = []
  const superseded: AgentSessionResumeMarker[] = []
  for (const marker of input.markers) {
    const record = input.getRecord(marker.sessionId)
    if (!record || !input.supportsRecord(record)) {
      continue
    }
    // The lease must be free and adjudicated. A contested or still-reconciling record is somebody
    // else's to resolve, and resuming into it is how a session gets two writers.
    if (input.leaseState !== 'may-be-held' && !isResumableStructuredAgentSessionRecord(record)) {
      continue
    }
    // A conversation that FORKED since teardown is not the one we marked, and can never be again:
    // deleted, so it cannot sit unseen forever. Compared by identity root,
    // because a resume legitimately advances Claude's leaf and that is not a fork.
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    if (!head) {
      continue
    }
    if (agentSessionProviderHandleRoot(head.handle) !== marker.providerHandleRoot) {
      superseded.push(marker)
      continue
    }
    if (input.movedOn(marker)) {
      superseded.push(marker)
      continue
    }
    const model = normalizeOptionalField(record.options?.model, AGENT_MODEL_MAX_LENGTH)
    candidates.push({
      sessionId: marker.sessionId,
      workspaceId: record.location.workspaceId,
      agent: record.provider,
      work: marker.work,
      trigger: marker.trigger,
      recordedAt: marker.recordedAt,
      latestPrompt: input.latestPrompt(marker.sessionId),
      executionHostId: record.location.executionHostId,
      workspaceKind: record.location.workspaceKind,
      ...(model === undefined ? {} : { model }),
      ...(marker.activity === undefined ? {} : { activity: marker.activity })
    })
  }
  return { candidates, superseded }
}
