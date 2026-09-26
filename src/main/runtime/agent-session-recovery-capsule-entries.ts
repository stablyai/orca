// The shape of the recovery capsule on disk, and how a stored set of records is read back.
//
// Split from the capsule so the file format — offer entries, failure records, the legacy v1 layout
// — can be read on its own. Every value parsed here re-enters from a file this process did not
// necessarily write, including one written by an older or newer build.

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
  latestPrompt: z.string().max(MAX_FAILURE_FIELD_LENGTH),
  latestUserItemId: z.string().max(MAX_FAILURE_FIELD_LENGTH).nullable()
})
// Failures sit under their own optional key rather than as a third entry state: an older build's
// entry parser rejects an unknown state and would lose every offer, but it ignores an unknown key.
const capsuleSchema = z.object({
  version: z.literal(2),
  entries: z.array(z.unknown()),
  dismissedAt: z.number().int().nonnegative().optional(),
  failed: z.unknown().optional()
})

/** What an acted-on offer left behind when the agent did not carry on. Current only while nothing
 *  newer happened in that chat; also dies with a dismissal, a successful retry, or a newer
 *  teardown of the same chat. */
export type AgentSessionResumeFailureRecord = {
  marker: AgentSessionResumeMarker
  failedAt: number
  outcome: AgentSessionResumeFailureOutcome
  reason: string
  /** The prompt the offer quoted, snapshotted because the session may no longer be readable. */
  latestPrompt: string
  /** The chat's newest user message when this was filed, as the marker records it at teardown. A
   *  different newest message means the user has since acted in that chat. */
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

// Failures are advisory, so one this build cannot read (say, a newer outcome) is dropped, and gone
// after the next write, rather than costing every offer and every later teardown record.
function parseFailures(value: unknown): AgentSessionResumeFailureRecord[] {
  return (Array.isArray(value) ? value : []).flatMap((failure: unknown) => {
    const parsed = failureSchema.safeParse(failure)
    const marker = parsed.success ? parseAgentSessionResumeMarker(parsed.data.marker) : null
    return parsed.success && marker ? [{ ...parsed.data, marker }] : []
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
    // The action lease, not an offer expiry: an offer has none. A reservation whose action died
    // is re-derived back to pending so a crashed resume cannot strand the offer forever.
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
        // A newer teardown of the same chat: it was working again, so the old verdict is stale.
        continue
      }
      // A retry of this failure that rolled back or whose lease lapsed. It stays a failure, never a
      // pending offer that an unselective "resume all" would silently re-run.
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
  // A single teardown may publish the same witness more than once. Different teardown IDs at the
  // same clock value have no ordering signal, so keep the first one rather than let a late writer
  // regress a newer witness from another host.
  return incoming.teardownId === current.teardownId
}
