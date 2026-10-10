// Which group lists each subagent: the groups this provider run wrote, and the ones earlier runs of
// the session journaled, inherited one at a time as this run's own reports reach them. Every lookup
// is read from the rows themselves, so no second index can disagree with what a row lists.

import { SubagentRosterRetention } from '../subagent-roster-retention'
import { subagentGroupJournalBody } from '../agent-session-journal/journal-subagent-group-body'
import { UNLABELLED_SUBAGENT } from './subagent-tracker-entries'
import type {
  JournaledSubagentSource,
  SubagentGroup,
  SubagentReport,
  TrackedSubagent
} from './subagent-tracker-types'

/** Settled history target; groups with unfinished children remain owned. */
export const MAX_SUBAGENT_GROUPS = 32
const MAX_SETTLED_IDENTITIES = 2048

export type LocatedSubagent<Placement> = {
  group: SubagentGroup<Placement>
  tracked: TrackedSubagent
}

export class SubagentTrackerGroups<Placement> {
  private readonly groups = new Map<string, SubagentGroup<Placement>>()
  private readonly retention = new SubagentRosterRetention(this.groups, {
    maxGroups: MAX_SUBAGENT_GROUPS,
    maxSettledIdentities: MAX_SETTLED_IDENTITIES,
    entries: (group) => [...group.entries.values()].map((tracked) => tracked.entry),
    // A released child's every run stays settled, so no replay of any of them lists it again.
    identities: (group) =>
      [...group.entries.values()].flatMap(({ entry, runs }) => [
        settledIdentity(entry.id, null),
        ...runs.map((run) => settledIdentity(entry.id, run))
      ]),
    onEvict: (group) => this.deps.onEvict?.(group)
  })

  constructor(
    private readonly deps: {
      journaled?: JournaledSubagentSource<Placement>
      /** A group no turn owns: later reports name it again, so its row is never released, or a
       *  later child would rewrite it from empty. */
      outsideTurn: (groupId: string) => boolean
      onEvict?: (group: SubagentGroup<Placement>) => void
    }
  ) {}

  private get journaled(): JournaledSubagentSource<Placement> | undefined {
    return this.deps.journaled
  }

  values(): Iterable<SubagentGroup<Placement>> {
    return this.groups.values()
  }

  get(groupId: string): SubagentGroup<Placement> | undefined {
    return this.groups.get(groupId)
  }

  /** The child's entry, inheriting the group an earlier provider run last listed it in. */
  locate(id: string): LocatedSubagent<Placement> | null {
    const listed = this.listed(id)
    if (listed) {
      return listed
    }
    const groupId = this.journaled?.groupOf(id) ?? null
    return groupId !== null && !this.groups.has(groupId) && this.inherit(groupId)
      ? this.listed(id)
      : null
  }

  /** This run's group for a key, else the earlier run's row it continues, else a new one. */
  groupFor(group: SubagentReport<Placement>['group']): SubagentGroup<Placement> {
    const existing = this.groups.get(group.id) ?? this.inherit(group.id)
    if (existing) {
      return existing
    }
    const created: SubagentGroup<Placement> = {
      groupId: group.id,
      placement: group.placement(),
      entries: new Map(),
      admittedEntries: 0,
      claimedLabels: new Set(),
      lastSerialized: null
    }
    this.groups.set(group.id, created)
    return created
  }

  hasSettled(id: string, run: string | null): boolean {
    return this.retention.hasSettled(settledIdentity(id, run))
  }

  /** A run an entry no longer remembers is settled for good. */
  rememberSettledRun(id: string, run: string): void {
    this.retention.rememberSettled(settledIdentity(id, run))
  }

  trim(changed: Iterable<SubagentGroup<Placement>>, retainedGroupId?: string): void {
    this.retention.trim(
      changed,
      (groupId) => groupId === retainedGroupId || this.deps.outsideTurn(groupId)
    )
  }

  sizes(): { groups: number; settledIdentities: number } {
    return this.retention.sizes()
  }

  clear(): void {
    this.retention.clear()
    this.groups.clear()
  }

  /** An older build could list one child in two rows: the inherited copy that counts is the one
   *  the journal reading says it last ran in; the other is history. */
  private listed(id: string): LocatedSubagent<Placement> | null {
    const chosen = this.journaled?.groupOf(id) ?? null
    for (const group of this.groups.values()) {
      const tracked = group.entries.get(id)
      if (tracked && !(tracked.inherited && chosen !== null && chosen !== group.groupId)) {
        return { group, tracked }
      }
    }
    return null
  }

  /** Once per group: after that this run's copy is the newer one. */
  private inherit(groupId: string): SubagentGroup<Placement> | null {
    const row = this.journaled?.claimGroup(groupId) ?? null
    if (!row) {
      return null
    }
    const group: SubagentGroup<Placement> = {
      groupId,
      // The row keeps the turn it was created beside; a later run's writes never move it.
      placement: row.placement,
      entries: new Map(),
      admittedEntries: row.entries.length,
      claimedLabels: new Set(row.entries.map((entry) => entry.label)),
      lastSerialized: JSON.stringify(subagentGroupJournalBody(groupId, row.entries))
    }
    for (const entry of row.entries) {
      group.entries.set(entry.id, {
        entry: { ...entry },
        run: null,
        runs: [],
        attempt: this.journaled?.attempt?.(entry.id) ?? 1,
        turn: null,
        // Each child outlived the run that spawned it, so none is tied to this run's turns.
        backgrounded: true,
        labelBase: entry.label,
        provisional: entry.label === UNLABELLED_SUBAGENT,
        inherited: true
      })
    }
    this.groups.set(groupId, group)
    // Counted as settled history now, even if only a lookup reached it; released by a later trim.
    this.retention.trim([group], () => true)
    return group
  }
}

function settledIdentity(id: string, run: string | null): string {
  return JSON.stringify([id, run])
}
