// Parse recovery offers/failures, including legacy layouts, from files written by independently versioned hosts.

import {
  readAgentSessionRefusalReference,
  type AgentSessionAnyRefusalDetails
} from '../../shared/agent-session-wire-refusals'
import { z } from 'zod'
import {
  AGENT_SESSION_RESUME_FAILURE_OUTCOMES,
  parseAgentSessionResumeMarker,
  type AgentSessionResumeFailureOutcome,
  type AgentSessionResumeMarker
} from '../../shared/agent-session-resume-marker'

const RESUME_ACTION_LEASE_TTL_MS = 10 * 60 * 1000
export const MAX_FAILURE_FIELD_LENGTH = 512

const legacyCapsuleSchema = z.object({ version: z.literal(1), markers: z.array(z.unknown()) })
const entrySchema = z.object({
  state: z.enum(['pending', 'in-progress']),
  operationId: z.string().min(1).optional(),
  startedAt: z.number().int().nonnegative().optional(),
  marker: z.unknown(),
  replacement: z.unknown().optional()
})
const failureSchema = z.object({
  marker: z.unknown(),
  failedAt: z.number().int().nonnegative(),
  outcome: z.enum(AGENT_SESSION_RESUME_FAILURE_OUTCOMES),
  reason: z.string().max(MAX_FAILURE_FIELD_LENGTH),
  details: z.unknown().optional(),
  latestPrompt: z.string().max(MAX_FAILURE_FIELD_LENGTH),
  latestUserItemId: z.string().max(MAX_FAILURE_FIELD_LENGTH).nullable()
})
// Keep failures in a separate optional key: older builds reject new entry states but ignore unknown keys.
const capsuleSchema = z.object({
  version: z.literal(2),
  entries: z.array(z.unknown()),
  dismissedAt: z.number().int().nonnegative().optional(),
  failed: z.unknown().optional()
})

/** Failure guidance remains until user action, successful retry, dismissal or a newer teardown supersedes it. */
export type AgentSessionResumeFailureRecord = {
  marker: AgentSessionResumeMarker
  failedAt: number
  outcome: AgentSessionResumeFailureOutcome
  /** Refusal code used by renderer guidance. */
  reason: string
  /** Optional refusal details; older/non-refusal rows and retired cause fields provide none. */
  details?: AgentSessionAnyRefusalDetails
  /** Snapshot the offered prompt because its source session may become unreadable. */
  latestPrompt: string
  /** A changed latest-user id proves the user acted since this failure was filed. */
  latestUserItemId: string | null
}

export type AgentSessionResumeFailureInput = Omit<AgentSessionResumeFailureRecord, 'marker'> & {
  sessionId: string
}

export type RecoveryEntry = {
  state: 'pending' | 'in-progress'
  operationId?: string
  startedAt?: number
  marker: AgentSessionResumeMarker
  replacement?: AgentSessionResumeMarker
}

export type RecoveryCapsuleState = {
  entries: RecoveryEntry[]
  failed: AgentSessionResumeFailureRecord[]
  dismissedAt?: number
}

function parseMarker(value: unknown): AgentSessionResumeMarker {
  const marker = parseAgentSessionResumeMarker(value)
  if (!marker) {
    throw new Error('agent_session_recovery_capsule_invalid')
  }
  return marker
}

function parseEntry(value: unknown): RecoveryEntry {
  const parsed = entrySchema.parse(value)
  const marker = parseMarker(parsed.marker)
  const replacement = parsed.replacement === undefined ? undefined : parseMarker(parsed.replacement)
  if (replacement && replacement.sessionId !== marker.sessionId) {
    throw new Error('agent_session_recovery_capsule_invalid')
  }
  if (parsed.state === 'pending') {
    return { state: 'pending', marker, ...(replacement ? { replacement } : {}) }
  }
  if (parsed.operationId === undefined || parsed.startedAt === undefined) {
    throw new Error('agent_session_recovery_capsule_invalid')
  }
  return {
    state: 'in-progress',
    operationId: parsed.operationId,
    startedAt: parsed.startedAt,
    marker,
    ...(replacement ? { replacement } : {})
  }
}

// Advisory failures may be dropped on downgrade; unreadable failure shapes must not lose offers or block teardown writes.
function parseFailures(value: unknown): AgentSessionResumeFailureRecord[] {
  return (Array.isArray(value) ? value : []).flatMap((failure: unknown) => {
    const parsed = failureSchema.safeParse(failure)
    const marker = parsed.success ? parseAgentSessionResumeMarker(parsed.data.marker) : null
    if (!parsed.success || !marker) {
      return []
    }
    const { details: stored, ...rest } = parsed.data
    const details = readAgentSessionRefusalReference({
      code: rest.reason,
      details: stored
    })?.details
    return [{ ...rest, marker, ...(details ? { details } : {}) }]
  })
}

export function parseState(raw: string): RecoveryCapsuleState {
  const value: unknown = JSON.parse(raw)
  const legacy = legacyCapsuleSchema.safeParse(value)
  if (legacy.success) {
    return {
      entries: legacy.data.markers.map((marker) => ({
        state: 'pending',
        marker: parseMarker(marker)
      })),
      failed: []
    }
  }
  const capsule = capsuleSchema.parse(value)
  return {
    entries: capsule.entries.map(parseEntry),
    failed: parseFailures(capsule.failed),
    ...(capsule.dismissedAt === undefined ? {} : { dismissedAt: capsule.dismissedAt })
  }
}

function sameWitness(left: AgentSessionResumeMarker, right: AgentSessionResumeMarker): boolean {
  return left.teardownId === right.teardownId && left.recordedAt === right.recordedAt
}

export function normalizeState(
  state: RecoveryCapsuleState,
  now: number
): Pick<RecoveryCapsuleState, 'entries' | 'failed'> {
  const bySession = new Map<string, RecoveryEntry>()
  for (const entry of state.entries) {
    const replacement = entry.replacement
    if (bySession.has(entry.marker.sessionId)) {
      throw new Error('agent_session_recovery_capsule_duplicate_session')
    }
    // Only action reservations expire; offers do not. Reclaim crashed actions so they cannot strand offers.
    const reclaimed =
      entry.state === 'in-progress' &&
      entry.startedAt !== undefined &&
      now - entry.startedAt > RESUME_ACTION_LEASE_TTL_MS
    const normalized: RecoveryEntry =
      entry.state === 'in-progress' && reclaimed
        ? { state: 'pending', marker: replacement ?? entry.marker }
        : entry.state === 'pending' && replacement
          ? { state: 'pending', marker: replacement }
          : entry
    bySession.set(normalized.marker.sessionId, normalized)
  }
  const failed: AgentSessionResumeFailureRecord[] = []
  for (const failure of state.failed) {
    if (failed.some((kept) => kept.marker.sessionId === failure.marker.sessionId)) {
      throw new Error('agent_session_recovery_capsule_duplicate_session')
    }
    const entry = bySession.get(failure.marker.sessionId)
    if (entry?.state === 'pending') {
      if (!sameWitness(entry.marker, failure.marker)) {
        // A newer teardown means the chat resumed; discard the old failure verdict.
        continue
      }
      // Failed retries stay failures after rollback/lease expiry; resume-all must not silently run them again.
      bySession.delete(failure.marker.sessionId)
    }
    failed.push(failure)
  }
  return { entries: [...bySession.values()], failed }
}

export function shouldReplaceMarker(
  current: AgentSessionResumeMarker,
  incoming: AgentSessionResumeMarker
): boolean {
  if (incoming.recordedAt !== current.recordedAt) {
    return incoming.recordedAt > current.recordedAt
  }
  // Equal timestamps across teardown ids cannot establish order; accept repeats only for the same witness.
  return incoming.teardownId === current.teardownId
}

/** Preserve records this host cannot list so a compatible build can act on them. */
export type KeepRecord = (marker: AgentSessionResumeMarker) => boolean

export function splitDismissedAll(
  state: Pick<RecoveryCapsuleState, 'entries' | 'failed'>,
  keep: KeepRecord
): { kept: Pick<RecoveryCapsuleState, 'entries' | 'failed'>; dismissedPending: number } {
  const entries = state.entries.filter((entry) => keep(entry.marker))
  return {
    kept: { entries, failed: state.failed.filter((failure) => keep(failure.marker)) },
    dismissedPending: state.entries.filter(
      (entry) => entry.state === 'pending' && !keep(entry.marker)
    ).length
  }
}
