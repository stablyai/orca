// Which group lists each subagent run: the groups this provider run wrote, and the ones earlier
// runs of the session journaled, inherited one at a time as this run's own reports reach them.

import { BoundedMap } from '../../../shared/bounded-map'
import { SubagentRosterRetention } from '../subagent-roster-retention'
import { subagentGroupJournalBody } from '../agent-session-journal/journal-subagent-group-body'
import type {
  JournaledSubagentSource,
  SubagentGroup,
  TrackedSubagent
} from './subagent-tracker-types'

/** Settled history target; groups with unfinished children remain owned. */
export const MAX_SUBAGENT_GROUPS = 32
const MAX_SETTLED_IDENTITIES = 2048
/** Runs remembered per child, so a late report finds the row its run is listed in. */
const MAX_RUNS_PER_SUBAGENT = 16

type ChildRuns = {
  /** The group listing the child's current run. */
  groupId: string
  runs: BoundedMap<string, string>
  /** Which run of the child the current one is: 1, then one more per run started. */
  attempt: number
}

export type LocatedSubagent<Placement> = {
  group: SubagentGroup<Placement>
  tracked: TrackedSubagent
}

export class SubagentTrackerGroups<Placement> {
  private readonly groups = new Map<string, SubagentGroup<Placement>>()
  private readonly children = new Map<string, ChildRuns>()
  private readonly retention = new SubagentRosterRetention(this.groups, {
    maxGroups: MAX_SUBAGENT_GROUPS,
    maxSettledIdentities: MAX_SETTLED_IDENTITIES,
    entries: (group) => [...group.entries.values()].map((tracked) => tracked.entry),
    identities: (group) => this.release(group),
    onEvict: (group) => this.onEvict?.(group)
  })

  constructor(
    private readonly journaled: JournaledSubagentSource<Placement> | undefined,
    private readonly onEvict?: (group: SubagentGroup<Placement>) => void
  ) {}

  values(): Iterable<SubagentGroup<Placement>> {
    return this.groups.values()
  }

  get(groupId: string): SubagentGroup<Placement> | undefined {
    return this.groups.get(groupId)
  }

  /** The child's current run, inheriting the group an earlier provider run last listed it in. */
  locate(id: string): LocatedSubagent<Placement> | null {
    const child = this.children.get(id)
    const group = child ? this.groups.get(child.groupId) : undefined
    const tracked = group?.entries.get(id)
    if (group && tracked) {
      return { group, tracked }
    }
    const inherited = child ? null : (this.journaled?.groupOf(id) ?? null)
    return inherited !== null && !this.groups.has(inherited) && this.inherit(inherited)
      ? this.locate(id)
      : null
  }

  /** The entry still showing a known run of the child; null for a run never seen, forgotten, or
   *  since replaced in its row by a later run. */
  locateRun(id: string, run: string): LocatedSubagent<Placement> | null {
    const groupId = this.children.get(id)?.runs.get(run)
    const group = groupId === undefined ? undefined : this.groups.get(groupId)
    const tracked = group?.entries.get(id)
    return group && tracked?.run === run ? { group, tracked } : null
  }

  /** Whether the child ever ran `run` here, listed or since replaced. */
  hasRun(id: string, run: string): boolean {
    return this.children.get(id)?.runs.has(run) ?? false
  }

  attempt(id: string): number {
    return this.children.get(id)?.attempt ?? 1
  }

  /** This run's group for a key, else the earlier run's row it continues, else a new one. */
  groupFor(groupId: string, placement: () => Placement): SubagentGroup<Placement> {
    const existing = this.groups.get(groupId) ?? this.inherit(groupId)
    if (existing) {
      return existing
    }
    const group: SubagentGroup<Placement> = {
      groupId,
      placement: placement(),
      entries: new Map(),
      admittedEntries: 0,
      claimedLabels: new Set(),
      lastSerialized: null
    }
    this.groups.set(groupId, group)
    return group
  }

  /** Lists `run` of the child in `group` as its current run. */
  place(id: string, group: SubagentGroup<Placement>, run: string | null, newRun: boolean): void {
    const child = this.children.get(id) ?? {
      groupId: group.groupId,
      runs: new BoundedMap<string, string>({
        maxEntries: MAX_RUNS_PER_SUBAGENT,
        // A run aged out of the history can never be started again by a late duplicate.
        onEvict: (_groupId, oldRun) => this.retention.rememberSettled(settledIdentity(id, oldRun))
      }),
      attempt: this.journaled?.attempt?.(id) ?? 1
    }
    if (newRun && this.children.has(id)) {
      child.attempt += 1
    }
    child.groupId = group.groupId
    if (run !== null) {
      child.runs.set(run, group.groupId)
    }
    this.children.set(id, child)
  }

  rekey(from: string, to: string): void {
    const child = this.children.get(from)
    if (child) {
      this.children.delete(from)
      this.children.set(to, child)
    }
  }

  forget(id: string): void {
    this.children.delete(id)
  }

  hasSettled(id: string, run: string | null): boolean {
    return this.retention.hasSettled(settledIdentity(id, run))
  }

  isKnown(id: string): boolean {
    return this.children.has(id)
  }

  trim(changed: Iterable<SubagentGroup<Placement>>, retainedGroupId?: string): void {
    this.retention.trim(changed, retainedGroupId)
  }

  sizes(): { groups: number; settledIdentities: number } {
    return this.retention.sizes()
  }

  clear(): void {
    this.retention.clear()
    this.groups.clear()
    this.children.clear()
  }

  /** An evicted group's children and runs: only those it still lists stop being tracked. */
  private release(group: SubagentGroup<Placement>): string[] {
    const identities: string[] = []
    for (const id of group.entries.keys()) {
      const child = this.children.get(id)
      if (!child) {
        continue
      }
      for (const [run, groupId] of child.runs.entries()) {
        if (groupId === group.groupId) {
          identities.push(settledIdentity(id, run))
          child.runs.delete(run)
        }
      }
      if (child.groupId === group.groupId) {
        identities.push(settledIdentity(id, null))
        this.children.delete(id)
      }
    }
    return identities
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
    this.groups.set(groupId, group)
    for (const entry of row.entries) {
      group.entries.set(entry.id, {
        entry: { ...entry },
        run: null,
        // Each child outlived the run that spawned it, so none is tied to this run's turns.
        backgrounded: true,
        labelBase: entry.label,
        provisional: false,
        inherited: true
      })
      // A child an older build listed in two rows lives only in the one the reading chose.
      if (this.journaled?.groupOf(entry.id) === groupId && !this.children.has(entry.id)) {
        this.place(entry.id, group, null, false)
      }
    }
    return group
  }
}

function settledIdentity(id: string, run: string | null): string {
  return JSON.stringify([id, run])
}
