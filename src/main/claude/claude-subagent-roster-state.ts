import type {
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
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
  /** Which run of this child. Identity survives a resume by design, so without
   *  this the retained rows of two runs read as one uninterrupted timeline. */
  attempt: number
  /** Inherited from a row an earlier provider run journaled, and not announced in
   *  this run yet. That run's calls are unknown here, so any announcement is a new
   *  invocation, and only an announcement reopens what that run settled. Any other
   *  frame can still give that run's outcome, such as Claude's "didn't finish before
   *  the previous session ended". */
  invokedInEarlierRun: boolean
}

export type RosterGroup = {
  groupId: string
  identity: AgentJournalItemIdentity
  /** The spawning turn's scope: the row reports its children beside that turn's work. */
  turnScope: AgentJournalTurnScope
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
  if (tracked.invokedInEarlierRun) {
    if (!frame.announcement) {
      // A verdict on that run, not an invocation of this one; the latch still guards it.
      return true
    }
    reopen(tracked, frame, now)
    if (frame.toolUseId) {
      tracked.invocationIds.add(frame.toolUseId)
      tracked.toolUseId = frame.toolUseId
    }
    return true
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
      // THE reactivation: a new spawn alias reopening this entry. Gated on the
      // observed alias change rather than on the counter, so a late duplicate
      // cannot advance a settled run.
      reopen(tracked, frame, now)
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

/** The one place the attempt moves. A new run starts its own clock, so the
 *  idle time since the last run never reads as run time. */
function reopen(tracked: TrackedEntry, frame: ClaudeSubagentTaskFrame, now: () => number): void {
  tracked.invokedInEarlierRun = false
  tracked.attempt += 1
  tracked.backgrounded = frame.backgrounded ?? false
  tracked.entry = {
    ...tracked.entry,
    state: frame.state ?? 'working',
    startedAt: now(),
    settledAt: undefined
  }
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
