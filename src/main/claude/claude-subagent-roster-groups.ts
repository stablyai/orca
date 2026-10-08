// Which spawn group holds each Claude subagent: the groups this provider run
// wrote, and the ones earlier runs of the session journaled, inherited one at a
// time as this run's own events reach them.

import {
  claudeSubagentGroupIdentity,
  inheritedClaudeSubagentGroup
} from './claude-subagent-group-row'
import type { AgentJournalTurnScope } from '../../shared/agent-session-journal-types'
import type { ClaudeJournaledRosterSource } from './claude-subagent-journaled-roster'
import type { RosterGroup, TrackedEntry } from './claude-subagent-roster-state'

/** Spawn-group rows kept live per session. Bounds an event-accumulated map that
 *  no provider snapshot ever prunes. */
const MAX_SUBAGENT_GROUPS = 32

export type LocatedClaudeSubagent = { group: RosterGroup; tracked: TrackedEntry }

export class ClaudeSubagentRosterGroups {
  private readonly groups = new Map<string, RosterGroup>()
  /** Canonical id → the group holding its entry, so a late update for a child
   *  from an earlier turn revises that turn's row instead of the live one. */
  private readonly groupIdByEntry = new Map<string, string>()

  constructor(
    private readonly deps: {
      journaled?: ClaudeJournaledRosterSource
      /** The open turn's scope, which a group this run creates belongs to. */
      currentTurnScope: () => AgentJournalTurnScope
      /** Once a group leaves the map nothing can reach its children again — not
       *  even a session sweep — so contact is lost here. */
      onEvicted: (group: RosterGroup) => void
    }
  ) {}

  get(groupId: string): RosterGroup | undefined {
    return this.groups.get(groupId)
  }

  values(): Iterable<RosterGroup> {
    return this.groups.values()
  }

  locate(id: string): LocatedClaudeSubagent | null {
    const groupId = this.groupIdByEntry.get(id)
    const group = groupId === undefined ? undefined : this.groups.get(groupId)
    const tracked = group?.entries.get(id)
    return group && tracked ? { group, tracked } : null
  }

  /** Finds a child, inheriting the group an earlier run last listed it in. */
  locateOrInherit(id: string): LocatedClaudeSubagent | null {
    const located = this.locate(id)
    if (located) {
      return located
    }
    const groupId = this.deps.journaled?.groupOf(id) ?? null
    return groupId !== null && !this.groups.has(groupId) && this.inherit(groupId)
      ? this.locate(id)
      : null
  }

  /** This run's group for a key, else the earlier run's row it continues — the
   *  key no turn owns is reused across runs — else a new one. */
  groupFor(groupId: string): RosterGroup {
    const existing = this.groups.get(groupId) ?? this.inherit(groupId)
    if (existing) {
      return existing
    }
    const group: RosterGroup = {
      groupId,
      identity: claudeSubagentGroupIdentity(groupId),
      turnScope: this.deps.currentTurnScope(),
      entries: new Map(),
      admittedEntries: 0,
      claimedLabels: new Set(),
      lastSerialized: null
    }
    this.admit(group)
    return group
  }

  place(id: string, groupId: string): void {
    this.groupIdByEntry.set(id, groupId)
  }

  forget(id: string): void {
    this.groupIdByEntry.delete(id)
  }

  clear(): void {
    this.groups.clear()
    this.groupIdByEntry.clear()
  }

  /** Once per group: after that this run's copy is the newer one. */
  private inherit(groupId: string): RosterGroup | null {
    const journaled = this.deps.journaled
    const row = journaled?.claimGroup(groupId) ?? null
    if (!journaled || !row) {
      return null
    }
    const group = inheritedClaudeSubagentGroup(groupId, row, journaled.attempt)
    this.admit(group)
    for (const id of group.entries.keys()) {
      // A child an older build listed in two rows lives only in the one the reading chose, whichever
      // row this run's frames reach first; the other copy is history.
      if (journaled.groupOf(id) === groupId) {
        this.groupIdByEntry.set(id, groupId)
      }
    }
    return group
  }

  private admit(group: RosterGroup): void {
    this.groups.set(group.groupId, group)
    while (this.groups.size > MAX_SUBAGENT_GROUPS) {
      const oldest = this.groups.keys().next()
      if (oldest.done || oldest.value === group.groupId) {
        break
      }
      const evicted = this.groups.get(oldest.value)
      if (evicted) {
        this.deps.onEvicted(evicted)
      }
      for (const id of evicted?.entries.keys() ?? []) {
        if (this.groupIdByEntry.get(id) === oldest.value) {
          this.groupIdByEntry.delete(id)
        }
      }
      this.groups.delete(oldest.value)
    }
  }
}
