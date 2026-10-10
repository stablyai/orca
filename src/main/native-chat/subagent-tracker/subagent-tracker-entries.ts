// How one listed child changes: its name, how it starts a run, and which states may replace which.

import {
  MAX_SUBAGENT_FIELD_CHARS,
  canReplaceSubagentState,
  isTerminalSubagentState
} from '../../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../../shared/native-chat-types'
import { ownRetainedString } from '../../../shared/own-retained-string'
import type { SubagentGroup, SubagentReport, TrackedSubagent } from './subagent-tracker-types'

export const UNLABELLED_SUBAGENT = 'subagent'

/** Provider strings are kept to one unit past the row's bound, so the row still marks the clip. */
export function boundedSubagentLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim()
  return trimmed ? ownRetainedString(trimmed.slice(0, MAX_SUBAGENT_FIELD_CHARS + 1)) : null
}

/** Two children can share a name; the ordinal keeps their rows apart without inventing a name the
 *  provider never sent. The probe is over the labels actually claimed, so a generated `Audit 2`
 *  never collides with a child the provider itself named `Audit 2`. */
export function claimSubagentLabel(group: SubagentGroup<unknown>, base: string): string {
  let candidate = base
  for (let ordinal = 2; group.claimedLabels.has(candidate); ordinal++) {
    candidate = `${base} ${ordinal}`
  }
  group.claimedLabels.add(candidate)
  return candidate
}

/** A run starting now. A new run keeps the token count its child already showed. */
export function startedSubagentEntry(
  report: SubagentReport<unknown>,
  label: string,
  now: number,
  previous?: NativeChatSubagentEntry
): NativeChatSubagentEntry {
  const state = report.state ?? 'working'
  const tokens = report.tokens ?? previous?.tokens
  return {
    id: report.id,
    label,
    state,
    startedAt: now,
    ...(isTerminalSubagentState(state) ? { settledAt: now } : {}),
    ...(tokens !== undefined ? { tokens } : {})
  }
}

/** Proven outcomes latch; lost contact can still receive a later verdict. Null when `state` may not
 *  replace the current one. */
export function withSubagentState(
  tracked: TrackedSubagent,
  state: NativeChatSubagentEntry['state'],
  now: number
): TrackedSubagent | null {
  if (tracked.entry.state === state || !canReplaceSubagentState(tracked.entry.state, state)) {
    return null
  }
  // Only a terminal state replaces another. A child an earlier provider process left ended with
  // that process: a verdict says how, not when.
  const settledAt = tracked.inherited ? tracked.entry.settledAt : now
  const { settledAt: _previous, ...rest } = tracked.entry
  return {
    ...tracked,
    entry: { ...rest, state, ...(settledAt !== undefined ? { settledAt } : {}) }
  }
}
