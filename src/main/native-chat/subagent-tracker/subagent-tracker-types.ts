// The one shape every agent reports its subagents in, and the state the shared tracker keeps.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentState
} from '../../../shared/native-chat-types'
import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/structured-agent-session-event-sink'

/** What an agent observed about one of its subagents. Started, updated and finished are the state it
 *  carries; the tracker decides what the row says. */
export type SubagentReport<Placement> = {
  /** The child's canonical id: the entry key, stable across its runs. */
  id: string
  /** One execution of the child: Claude's spawn or resume call, Codex's child turn. Absent when the
   *  agent cannot tell, which means whichever run is current. */
  run?: string
  /** The group of the turn this report happens in: where a new child is listed. A known child
   *  keeps its one entry, run after run. */
  group: { id: string; placement: () => Placement }
  /** Only an announcement creates a child or starts a run; anything else revises a known one. */
  announces: boolean
  label?: string | null
  state?: NativeChatSubagentState | null
  /** Latest total the provider counted for this child. */
  tokens?: number
  /** Told to outlive the turn that spawned it, so that turn's end is no evidence about it. */
  backgrounded?: boolean
}

export type TrackedSubagent = {
  entry: NativeChatSubagentEntry
  /** The run this entry shows; null when unknown (a provisional child, or one an earlier provider
   *  run journaled). */
  run: string | null
  /** Runs this entry has shown, oldest first and bounded; a report for one of them is stale. */
  runs: string[]
  /** Which run of the child this is: 1, then one more per run started. */
  attempt: number
  /** The group of the turn that started the current run, wherever the entry is listed: that turn's
   *  end is what a foreground run cannot outlive. Null for a run an earlier provider process left. */
  turn: string | null
  backgrounded: boolean
  /** The name before its ordinal suffix; a placeholder until an announcement names the child. */
  labelBase: string
  provisional: boolean
  /** Listed by an earlier provider run and not run again here: a verdict says how it ended, not when. */
  inherited: boolean
}

export type SubagentGroup<Placement> = {
  groupId: string
  placement: Placement
  /** Insertion order is the display order. */
  entries: Map<string, TrackedSubagent>
  /** Lifetime admissions: bounds the labels a row retains even after removals. */
  admittedEntries: number
  /** Labels stay reserved after removal or renaming, so an ordinal is never reused. */
  claimedLabels: Set<string>
  /** Last body written and accepted, so an identical revision is not written twice. */
  lastSerialized: string | null
}

/** Where a group's row goes: the journal sink, or a provider timeline the host admits later. */
export type SubagentRowPort<Placement> = {
  write: (
    group: SubagentGroup<Placement>,
    body: SubagentRowBody
  ) => StructuredAgentSessionSinkAdmission
}

export type SubagentRowBody = {
  /** Null when the group lost its last child and its row is removed. */
  body: AgentJournalMessageItem | null
  serialized: string
}

/** What earlier provider runs of the session journaled, inherited one group at a time. */
export type JournaledSubagentSource<Placement> = {
  /** The group row an earlier run last listed this child in. */
  groupOf: (id: string) => string | null
  /** That group's row, handed over once: after that the tracker's copy is the newer one. */
  claimGroup: (
    groupId: string
  ) => { entries: readonly NativeChatSubagentEntry[]; placement: Placement } | null
  /** The latest run number any row records for this child; 1 when none says more. */
  attempt?: (id: string) => number
}
