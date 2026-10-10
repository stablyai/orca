// The one subagent tracker every native-chat agent reports into.
//
// An agent's own code only reads its provider's events and reports what it saw about a child in
// one shape. This tracker decides everything the user sees from that: which turn's row lists a
// child, its name, how its state may change, what a turn's or the session's end means for it, and
// how the row is written. A child keeps one entry, in the row of the turn that first spawned it;
// a later run reopens that entry. A child is released only when it settles (bounded settled
// history) or the chat ends — never by count while it may still run.

import type { NativeChatSubagentEntry } from '../../../shared/native-chat-types'
import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/structured-agent-session-event-sink'
import { writeSubagentRows } from './subagent-row-writes'
import {
  UNLABELLED_SUBAGENT,
  boundedSubagentLabel,
  claimSubagentLabel,
  startedSubagentEntry,
  withSubagentState
} from './subagent-tracker-entries'
import { SubagentTrackerGroups, type LocatedSubagent } from './subagent-tracker-groups'
import type {
  JournaledSubagentSource,
  SubagentGroup,
  SubagentReport,
  SubagentRowPort,
  TrackedSubagent
} from './subagent-tracker-types'

/** Children one row lists. Bounds the row, which is rewritten on every change. */
export const MAX_SUBAGENTS_PER_GROUP = 64
/** Runs one entry remembers, so a late report for one cannot pass for a new run. */
const MAX_RUNS_PER_SUBAGENT = 16
const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export class SubagentTracker<Placement> {
  private readonly groups: SubagentTrackerGroups<Placement>
  /** Groups changed inside `batch`, written once when it ends. */
  private pending: Set<SubagentGroup<Placement>> | null = null
  private readonly now: () => number

  constructor(
    private readonly deps: {
      port: SubagentRowPort<Placement>
      journaled?: JournaledSubagentSource<Placement>
      /** Whether a group is the one no turn owns. */
      outsideTurn: (groupId: string) => boolean
      onEvict?: (group: SubagentGroup<Placement>) => void
      now?: () => number
    }
  ) {
    this.now = deps.now ?? (() => Date.now())
    this.groups = new SubagentTrackerGroups(deps)
  }

  report(report: SubagentReport<Placement>): StructuredAgentSessionSinkAdmission {
    const run = report.run ?? null
    const current = this.groups.locate(report.id)
    if (this.groups.hasSettled(report.id, run) && (run !== null || !current)) {
      return ADMITTED
    }
    if (!current) {
      return report.announces ? this.create(report, run) : ADMITTED
    }
    const { tracked } = current
    if (run === null || run === tracked.run) {
      return this.revise(current, report)
    }
    if (tracked.runs.includes(run)) {
      // A run since superseded: nothing it says changes the run shown now.
      return ADMITTED
    }
    if (tracked.inherited && !report.announces) {
      // A verdict on the run an earlier provider process left, under one of its calls.
      return this.revise(current, report)
    }
    if (tracked.run === null && !tracked.inherited) {
      // A child listed before its run was known learns it.
      const learned = { ...tracked, run, runs: [run] }
      current.group.entries.set(report.id, learned)
      return this.revise({ group: current.group, tracked: learned }, report)
    }
    return report.announces ? this.startRun(current, report, run) : ADMITTED
  }

  /** Re-keys a provisional child onto the canonical id the provider finally named. */
  rekey(from: string, to: string): void {
    const located = this.groups.locate(from)
    if (!located || from === to) {
      return
    }
    const entries = [...located.group.entries].map(([id, tracked]): [string, TrackedSubagent] =>
      id === from ? [to, { ...tracked, entry: { ...tracked.entry, id: to } }] : [id, tracked]
    )
    located.group.entries = new Map(entries)
  }

  /** The child turned out not to be a subagent at all; its row forgets it. */
  remove(id: string): StructuredAgentSessionSinkAdmission {
    const located = this.groups.locate(id)
    if (!located) {
      return ADMITTED
    }
    located.group.entries.delete(id)
    return this.write(located.group)
  }

  locate(id: string): LocatedSubagent<Placement> | null {
    return this.groups.locate(id)
  }

  /** Known now, or settled and released: either way not some other kind of work. */
  has(id: string): boolean {
    return this.groups.locate(id) !== null || this.groups.hasSettled(id, null)
  }

  hasSettled(id: string, run: string | null): boolean {
    return this.groups.hasSettled(id, run)
  }

  /** Which run of the child its current one is. */
  attempt(id: string): number {
    return this.groups.locate(id)?.tracked.attempt ?? 1
  }

  /** Keeps a group a child's own traffic just reached, whatever retention would release. */
  retain(group: SubagentGroup<Placement>): void {
    this.groups.trim([group], group.groupId)
  }

  /** The turn ended: a run it started in the foreground can no longer report, wherever its child is
   *  listed, and contact with it is lost — not evidence it exited. A backgrounded run was told to
   *  outlive the turn. */
  settleTurn(groupId: string): StructuredAgentSessionSinkAdmission {
    const swept: SubagentGroup<Placement>[] = []
    for (const group of this.groups.values()) {
      let changed = false
      for (const [id, tracked] of group.entries) {
        if (tracked.turn === groupId && !tracked.backgrounded) {
          changed = this.setState(group, id, tracked, 'unverifiable') || changed
        }
      }
      if (changed || group.groupId === groupId) {
        swept.push(group)
      }
    }
    return this.write(...swept)
  }

  /** The provider is gone: nothing more arrives for any child. Every group is swept; the first
   *  refusal is handed back after all were tried. */
  settleSession(): StructuredAgentSessionSinkAdmission {
    let refused: StructuredAgentSessionSinkAdmission | null = null
    for (const group of this.groups.values()) {
      const admission = this.sweep(group)
      refused ??= admission.accepted ? null : admission
    }
    return refused ?? ADMITTED
  }

  /** Writes each group the reports inside `apply` changed once, after all of them. */
  batch(apply: () => void): StructuredAgentSessionSinkAdmission {
    if (this.pending) {
      apply()
      return ADMITTED
    }
    const changed = new Set<SubagentGroup<Placement>>()
    this.pending = changed
    try {
      apply()
    } finally {
      this.pending = null
    }
    return this.flush(changed)
  }

  sizes(): { groups: number; settledIdentities: number } {
    return this.groups.sizes()
  }

  dispose(): void {
    this.settleSession()
    this.groups.clear()
  }

  private create(
    report: SubagentReport<Placement>,
    run: string | null
  ): StructuredAgentSessionSinkAdmission {
    const group = this.groups.groupFor(report.group)
    if (group.admittedEntries >= MAX_SUBAGENTS_PER_GROUP) {
      return ADMITTED
    }
    group.admittedEntries += 1
    const label = boundedSubagentLabel(report.label)
    group.entries.set(report.id, {
      entry: startedSubagentEntry(
        report,
        claimSubagentLabel(group, label ?? UNLABELLED_SUBAGENT),
        this.now()
      ),
      run,
      runs: run === null ? [] : [run],
      attempt: 1,
      turn: report.group.id,
      backgrounded: report.backgrounded ?? false,
      labelBase: label ?? UNLABELLED_SUBAGENT,
      provisional: label === null,
      inherited: false
    })
    return this.write(group)
  }

  /** A new run of a known child reopens its one entry, wherever the row listing it is: its clock
   *  starts again, and it is the next attempt. */
  private startRun(
    current: LocatedSubagent<Placement>,
    report: SubagentReport<Placement>,
    run: string
  ): StructuredAgentSessionSinkAdmission {
    const { group, tracked } = current
    const runs = [...tracked.runs, run]
    for (const forgotten of runs.splice(0, runs.length - MAX_RUNS_PER_SUBAGENT)) {
      this.groups.rememberSettledRun(report.id, forgotten)
    }
    const label = boundedSubagentLabel(report.label)
    const named = tracked.provisional && label !== null && label !== UNLABELLED_SUBAGENT
    group.entries.set(report.id, {
      entry: startedSubagentEntry(
        report,
        named ? claimSubagentLabel(group, label) : tracked.entry.label,
        this.now(),
        tracked.entry
      ),
      run,
      runs,
      attempt: tracked.attempt + 1,
      turn: report.group.id,
      backgrounded: report.backgrounded ?? false,
      labelBase: named ? label : tracked.labelBase,
      provisional: tracked.provisional && !named,
      inherited: false
    })
    return this.write(group)
  }

  private revise(
    located: LocatedSubagent<Placement>,
    report: SubagentReport<Placement>
  ): StructuredAgentSessionSinkAdmission {
    const { group, tracked } = located
    const id = tracked.entry.id
    const next: TrackedSubagent = {
      ...tracked,
      backgrounded: report.backgrounded ?? tracked.backgrounded,
      entry: { ...tracked.entry }
    }
    const label = boundedSubagentLabel(report.label)
    if (label !== null && tracked.provisional && label !== UNLABELLED_SUBAGENT) {
      next.provisional = false
      next.labelBase = label
      next.entry.label = claimSubagentLabel(group, label)
    }
    if (typeof report.tokens === 'number') {
      next.entry.tokens = report.tokens
    }
    group.entries.set(id, next)
    if (report.state) {
      this.setState(group, id, next, report.state)
    }
    return this.write(group)
  }

  private setState(
    group: SubagentGroup<Placement>,
    id: string,
    tracked: TrackedSubagent,
    state: NativeChatSubagentEntry['state']
  ): boolean {
    const next = withSubagentState(tracked, state, this.now())
    if (next) {
      group.entries.set(id, next)
    }
    return next !== null
  }

  private sweep(group: SubagentGroup<Placement>): StructuredAgentSessionSinkAdmission {
    for (const [id, tracked] of group.entries) {
      this.setState(group, id, tracked, 'unverifiable')
    }
    // A null `lastSerialized` is a refused earlier write that nothing else may retry.
    return this.write(group)
  }

  private write(...groups: SubagentGroup<Placement>[]): StructuredAgentSessionSinkAdmission {
    if (this.pending) {
      groups.forEach((group) => this.pending?.add(group))
      return ADMITTED
    }
    return this.flush(groups)
  }

  private flush(groups: Iterable<SubagentGroup<Placement>>): StructuredAgentSessionSinkAdmission {
    const written = [...groups]
    const refused = writeSubagentRows(written, this.deps.port)
    this.groups.trim(written)
    return refused ?? ADMITTED
  }
}
