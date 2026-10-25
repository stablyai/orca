// Trust stop-time witnesses, not post-attach journal rewrites. Delete superseded/forked offers;
// structural refusal preserves them for a compatible build or later ownership resolution.

import type { AgentSessionAnyRefusalDetails } from '../../../shared/agent-session-wire-refusals'
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
  latestPrompt: string
  executionHostId: AgentSessionRecord['location']['executionHostId']
  /** Distinguish folder workspaces from git worktrees without inferring names. */
  workspaceKind: AgentSessionRecord['location']['workspaceKind']
  model?: string
  /** Stop-time snapshot; absent on older hosts/markers. */
  activity?: AgentSessionRestartActivity
}

export type StructuredAgentSessionResumeFailure = StructuredAgentSessionResumeCandidate & {
  failedAt: number
  outcome: AgentSessionResumeFailureOutcome
  reason: string
  /** Absent for older records or non-refusal failures. */
  details?: AgentSessionAnyRefusalDetails
  /** Derive eligibility; uncertain delivery or newer user work prevents retry regardless of failure wording. */
  retryable: boolean
}

/** Limit old clients to agents they can show, across listing, resume and dismissal. */
export type StructuredAgentSessionRestartAudience = (agent: string) => boolean

export function restartRowsFor<T extends { agent: string }>(
  rows: T[],
  audience: StructuredAgentSessionRestartAudience | undefined
): T[] {
  return audience ? rows.filter((row) => audience(row.agent)) : rows
}

export type StructuredAgentSessionResumableSet = {
  candidates: StructuredAgentSessionResumeCandidate[]
  /** Retire these durable markers instead of repeatedly hiding them. */
  superseded: AgentSessionResumeMarker[]
}

export type StructuredAgentSessionResumeSetInput = {
  markers: readonly AgentSessionResumeMarker[]
  getRecord: (sessionId: string) => AgentSessionRecord | null
  supportsRecord: (record: AgentSessionRecord) => boolean
  latestPrompt: (sessionId: string) => string
  movedOn: (marker: AgentSessionResumeMarker) => boolean
  savedByNewerOrca: (sessionId: string) => boolean
  /** may-be-held relaxes ownership only, preserving all other eligibility checks. */
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
    if (record.providerContextBoundary?.operationId !== marker.contextClearOperationId) {
      superseded.push(marker)
      continue
    }
    // Require adjudicated ownership to avoid admitting a second writer.
    if (input.leaseState !== 'may-be-held' && !isResumableStructuredAgentSessionRecord(record)) {
      continue
    }
    // Compare identity roots; Claude’s advancing leaf is continuity, while a new root permanently ends the offer.
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
    // Preserve newer-chat offers for a build that can act on them.
    if (input.savedByNewerOrca(marker.sessionId)) {
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
