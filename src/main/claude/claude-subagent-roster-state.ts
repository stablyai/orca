import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import type { ClaudeSubagentTaskFrame } from './claude-subagent-task-frames'

const MAX_INVOCATIONS_PER_SUBAGENT = 16

export type TrackedEntry = {
  entry: NativeChatSubagentEntry
  /** The only signal separating a child that dies with its turn from one told to
   *  outlive it. A turn-end sweep must leave a backgrounded child alone. */
  backgrounded: boolean
  toolUseId: string | null
  invocationIds: Set<string> | null
  /** Label before its ordinal suffix, so a later announcement can tell a
   *  provisional row from one that already carries the provider's own name. */
  labelBase: string
}

export type RosterGroup = {
  groupId: string
  identity: AgentJournalItemIdentity
  /** Insertion order is the display order; the map holds the state. */
  entries: Map<string, TrackedEntry>
  /** Lifetime admissions bound retained labels even when entries are removed. */
  admittedEntries: number
  /** Labels remain reserved after removal or provisional-name replacement. */
  claimedLabels: Set<string>
  /** Last body written, so an idempotent replay writes no new revision. */
  lastSerialized: string | null
}

// Invocation history stays with the entry, independent of the evicting alias cache.
export function applyClaudeSubagentInvocation(
  tracked: TrackedEntry,
  frame: ClaudeSubagentTaskFrame,
  now: () => number
): boolean {
  if (tracked.invocationIds === null) {
    return false
  }
  const newInvocation =
    frame.announcement && frame.toolUseId !== null && !tracked.invocationIds.has(frame.toolUseId)
  if (newInvocation && frame.toolUseId) {
    if (tracked.invocationIds.size >= MAX_INVOCATIONS_PER_SUBAGENT) {
      tracked.invocationIds = null
      tracked.entry = { ...tracked.entry, state: 'unverifiable', settledAt: now() }
      return true
    }
    tracked.invocationIds.add(frame.toolUseId)
    if (tracked.toolUseId !== null && tracked.toolUseId !== frame.toolUseId) {
      tracked.backgrounded = frame.backgrounded ?? false
      tracked.entry = { ...tracked.entry, state: frame.state ?? 'working', settledAt: undefined }
    }
    tracked.toolUseId = frame.toolUseId
  } else if (tracked.toolUseId && frame.toolUseId && tracked.toolUseId !== frame.toolUseId) {
    return false
  }
  if (tracked.toolUseId === null) {
    tracked.toolUseId = frame.toolUseId
  }
  return true
}

/** Two children can share a description; the ordinal keeps their rows apart
 *  without inventing a name the provider never sent. The probe is over the
 *  labels actually rendered, not a per-base counter: a generated `Audit 2`
 *  must not collide with a provider that names its own child `Audit 2`. */
export function claimClaudeSubagentLabel(group: RosterGroup, base: string): string {
  let candidate = base
  for (let ordinal = 2; group.claimedLabels.has(candidate); ordinal++) {
    candidate = `${base} ${ordinal}`
  }
  group.claimedLabels.add(candidate)
  return candidate
}
