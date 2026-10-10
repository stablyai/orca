// Which spawn group holds each Claude subagent: the groups this provider run
// wrote, and the ones earlier runs of the session journaled, inherited one at a
// time as this run's own events reach them.

import { SubagentRosterRetention } from '../native-chat/subagent-roster-retention'
import {
  claudeSubagentGroupIdentity,
  inheritedClaudeSubagentGroup
} from './claude-subagent-group-row'
import type { AgentJournalTurnScope } from '../../shared/agent-session-journal-types'
import type { ClaudeJournaledRosterSource } from './claude-subagent-journaled-roster'
import type { RosterGroup, TrackedEntry } from './claude-subagent-roster-state'

/** Settled history target; groups with unfinished children remain owned. */
const MAX_SUBAGENT_GROUPS = 32

export type LocatedClaudeSubagent = { group: RosterGroup; tracked: TrackedEntry }

export class ClaudeSubagentRosterGroups {
  private readonly groups = new Map<string, RosterGroup>()
  /** Canonical id → the group holding its entry, so a late update for a child
   *  from an earlier turn revises that turn's row instead of the live one. */
  private readonly groupIdByEntry = new Map<string, string>()

  private readonly retention = new SubagentRosterRetention(this.groups, {
    maxGroups: MAX_SUBAGENT_GROUPS,
    maxSettledIdentities: 2048,
    entries: (group) => [...group.entries.values()].map((tracked) => tracked.entry),
    identities: (group) =>
      [...group.entries]
        .filter(([id]) => this.groupIdByEntry.get(id) === group.groupId)
        .flatMap(([id, tracked]) => [
          claudeSubagentRetentionIdentity(id, null),
          ...[...new Set([...(tracked.invocationIds ?? []), tracked.toolUseId])].map((toolUseId) =>
            claudeSubagentRetentionIdentity(id, toolUseId)
          )
        ]),
    onEvict: (group) => {
      for (const id of group.entries.keys()) {
        if (this.groupIdByEntry.get(id) === group.groupId) {
          this.groupIdByEntry.delete(id)
        }
      }
    }
  })

  constructor(
    private readonly deps: {
      journaled?: ClaudeJournaledRosterSource
      /** The open turn's scope, which a group this run creates belongs to. */
      currentTurnScope: () => AgentJournalTurnScope
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

  hasSettled(id: string, toolUseId: string | null): boolean {
    return this.retention.hasSettled(claudeSubagentRetentionIdentity(id, toolUseId))
  }

  trim(group: RosterGroup, retainAccessed = false): void {
    this.retention.trim([group], retainAccessed ? group.groupId : undefined)
  }

  clear(): void {
    this.retention.clear()
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
  }
}

function claudeSubagentRetentionIdentity(id: string, toolUseId: string | null): string {
  return JSON.stringify([id, toolUseId])
}
