// The one subagent tracker every native-chat agent reports into.
//
// An agent's own code only reads its provider's events and reports what it saw about a child in
// one shape. This tracker decides everything the user sees from that: which turn's row lists a
// child, its name, how its state may change, what a turn's or the session's end means for it, and
// how the row is written. A child is released only when it settles (bounded settled history) or
// the chat ends — never by count while it may still run.

import { isTerminalSubagentState } from '../../../shared/native-chat-subagent-summary'
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
      onEvict?: (group: SubagentGroup<Placement>) => void
      now?: () => number
    }
  ) {
    this.now = deps.now ?? (() => Date.now())
    this.groups = new SubagentTrackerGroups(deps.journaled, deps.onEvict)
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
    if (run === null || run === current.tracked.run) {
      return this.revise(current, report)
    }
    if (this.groups.hasRun(report.id, run)) {
      // A late report about a run since superseded: it can still say how that run ended, while a row
      // still shows it. It never starts that run again.
      const listed = this.groups.locateRun(report.id, run)
      return listed
        ? this.revise(listed, { ...report, label: null, backgrounded: undefined })
        : ADMITTED
    }
    if (current.tracked.inherited && !report.announces) {
      // A verdict on the run an earlier provider process left, under one of its calls.
      return this.revise(current, report)
    }
    if (current.tracked.run === null && !current.tracked.inherited) {
      // A provisional child learns the run it belongs to.
      current.tracked.run = run
      this.groups.place(report.id, current.group, run, false)
      return this.revise(current, report)
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
    this.groups.rekey(from, to)
  }

  /** The child turned out not to be a subagent at all; its row forgets it. */
  remove(id: string): StructuredAgentSessionSinkAdmission {
    const located = this.groups.locate(id)
    if (!located) {
      return ADMITTED
    }
    located.group.entries.delete(id)
    this.groups.forget(id)
    return this.write(located.group)
  }

  locate(id: string): LocatedSubagent<Placement> | null {
    return this.groups.locate(id)
  }

  /** Known now, or settled and released: either way not some other kind of work. */
  has(id: string): boolean {
    return this.groups.isKnown(id) || this.groups.hasSettled(id, null)
  }

  hasSettled(id: string, run: string | null): boolean {
    return this.groups.hasSettled(id, run)
  }

  /** Which run of the child its current one is. */
  attempt(id: string): number {
    return this.groups.attempt(id)
  }

  /** Keeps a group a child's own traffic just reached, whatever retention would release. */
  retain(group: SubagentGroup<Placement>): void {
    this.groups.trim([group], group.groupId)
  }

  /** The turn ended: a child it ran in the foreground can no longer report, and contact with it is
   *  lost — not evidence it exited. A backgrounded child was told to outlive the turn. */
  settleTurn(groupId: string): StructuredAgentSessionSinkAdmission {
    const group = this.groups.get(groupId)
    return group ? this.sweep(group, false) : ADMITTED
  }

  /** The provider is gone: nothing more arrives for any child. Every group is swept; the first
   *  refusal is handed back after all were tried. */
  settleSession(): StructuredAgentSessionSinkAdmission {
    let refused: StructuredAgentSessionSinkAdmission | null = null
    for (const group of this.groups.values()) {
      const admission = this.sweep(group, true)
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
    const group = this.groups.groupFor(report.group.id, report.group.placement)
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
      backgrounded: report.backgrounded ?? false,
      labelBase: label ?? UNLABELLED_SUBAGENT,
      provisional: label === null,
      inherited: false
    })
    this.groups.place(report.id, group, run, false)
    return this.write(group)
  }

  /** A new run of a known child: listed in the turn that started it. The row of the run before keeps
   *  its history, and stops claiming that run is live. */
  private startRun(
    current: LocatedSubagent<Placement>,
    report: SubagentReport<Placement>,
    run: string
  ): StructuredAgentSessionSinkAdmission {
    const group = this.groups.groupFor(report.group.id, report.group.placement)
    const changed = [group]
    if (group !== current.group && !isTerminalSubagentState(current.tracked.entry.state)) {
      this.setState(current.group, report.id, current.tracked, 'unverifiable')
      changed.push(current.group)
    }
    const listed = group.entries.get(report.id)
    if (!listed && group.admittedEntries >= MAX_SUBAGENTS_PER_GROUP) {
      return this.write(...changed.slice(1))
    }
    if (!listed) {
      group.admittedEntries += 1
    }
    const base = current.tracked.labelBase
    group.entries.set(report.id, {
      entry: startedSubagentEntry(
        report,
        listed?.entry.label ?? claimSubagentLabel(group, base),
        this.now(),
        listed?.entry ?? current.tracked.entry
      ),
      run,
      backgrounded: report.backgrounded ?? false,
      labelBase: base,
      provisional: current.tracked.provisional,
      inherited: false
    })
    this.groups.place(report.id, group, run, true)
    return this.write(...changed)
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
  ): void {
    const next = withSubagentState(tracked, state, this.now())
    if (next) {
      group.entries.set(id, next)
    }
  }

  private sweep(
    group: SubagentGroup<Placement>,
    includeBackgrounded: boolean
  ): StructuredAgentSessionSinkAdmission {
    for (const [id, tracked] of group.entries) {
      if (!isTerminalSubagentState(tracked.entry.state)) {
        if (includeBackgrounded || !tracked.backgrounded) {
          this.setState(group, id, tracked, 'unverifiable')
        }
      }
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
