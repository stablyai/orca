// The Claude subagent roster: one journal row per turn that spawned children.
//
// Entries are built from `task_started`, never from child traffic: a
// BACKGROUNDED subagent emits no child frames at all, so a roster fed by
// `parent_tool_use_id` alone would leave every one of them an unlabelled row
// forever. Child traffic only creates an entry for CLI releases that announce
// no task frames.
//
// Claude re-announces a resumed task under a NEW `tool_use_id`, so `task_id` is
// the key and tool ids are aliases; keying on the tool id would duplicate the
// child on every resume. Outcomes latch within an invocation; a new spawn
// alias can reopen it, and authoritative evidence can correct lost contact.
//
// The state is one provider run's, but its rows are the session's. A run
// inherits what earlier runs journaled, one group at a time as its own events
// reach it, so a restart neither splits a child nor erases a row's children.

import type { AgentJournalTurnScope } from '../../shared/agent-session-journal-types'
import {
  canReplaceSubagentState,
  isTerminalSubagentState
} from '../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { isBoundedClaudeTaskId } from './claude-background-task-tracker'
import { writeClaudeSubagentGroupRow } from './claude-subagent-group-row'
import { ClaudeSubagentIds } from './claude-subagent-id-aliases'
import type { ClaudeJournaledRosterSource } from './claude-subagent-journaled-roster'
import { ClaudeSubagentRosterGroups } from './claude-subagent-roster-groups'
import {
  ClaudeSubagentLinkage,
  type ClaudeAgentLinkageSource,
  type ClaudeSubagentLinkageSource
} from './claude-subagent-linkage'
import { readClaudeSubagentTaskFrame } from './claude-subagent-task-frames'
import {
  applyClaudeSubagentInvocation,
  claimClaudeSubagentLabel,
  type RosterGroup,
  type TrackedEntry
} from './claude-subagent-roster-state'

/** Children per spawn-group row. Bounds an event-accumulated map that no
 *  provider snapshot ever prunes. */
const MAX_SUBAGENTS_PER_GROUP = 64

/** The turn a group belongs to when Claude reports a task outside any turn. */
const OUTSIDE_TURN = 'outside-turn'

const UNLABELLED_AGENT = 'subagent'

export type ClaudeSubagentRosterDeps = {
  sink: StructuredAgentSessionEventSink
  /** The turn that owns children spawned right now; null outside any turn. */
  currentGroupKey: () => string | null
  /** That turn's scope, which the roster row it spawns belongs to. */
  currentTurnScope: () => AgentJournalTurnScope
  /** Whether a tool id was forwarded at the TOP level. A child parented to one
   *  was spawned by a call the transcript shows, so its announcement is still
   *  expected; a child parented to anything else names an id that only ever
   *  existed inside a sidechain, which this CLI will never announce. */
  isForwardedParentTool?: (toolUseId: string) => boolean
  /** The reference naming the child that journaled a tool call, when a child
   *  did. It is how a grandchild's row reaches the agent that spawned it. */
  childOwnerRefOf?: (toolUseId: string) => string | null
  /** What earlier provider runs of this session journaled of this roster. */
  journaled?: ClaudeJournaledRosterSource
  /** A settled group can receive no further announcement, so an identity still
   *  provisional will stay that way. Fires on EVERY settle path, so a caller
   *  holding rows against a pending identity cannot miss one. */
  onIdentitiesFinal?: () => void
  now?: () => number
}

export class ClaudeSubagentRoster {
  private readonly groups: ClaudeSubagentRosterGroups
  private readonly ids: ClaudeSubagentIds
  /** Who produced a row, for every write site journaling this session. */
  readonly linkage: ClaudeSubagentLinkageSource & ClaudeAgentLinkageSource
  /** Set by ANY `task_started`, including one the subagent filter rejects. Once
   *  this CLI has proven it declares its tasks, child traffic for an id it never
   *  announced is a nested tool or a grandchild, not a subagent. */
  private announcesTasks = false
  private readonly now: () => number

  constructor(private readonly deps: ClaudeSubagentRosterDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.groups = new ClaudeSubagentRosterGroups({
      journaled: deps.journaled,
      currentTurnScope: deps.currentTurnScope
    })
    this.ids = new ClaudeSubagentIds(deps.journaled?.canonical)
    this.linkage = new ClaudeSubagentLinkage({
      ids: this.ids,
      trackedFor: (canonicalId) => this.groups.locate(canonicalId)?.tracked ?? null,
      isForwardedParentTool: deps.isForwardedParentTool,
      childOwnerRefOf: deps.childOwnerRefOf,
      spawnRefOf: (canonicalId) => this.groups.locate(canonicalId)?.tracked.toolUseId ?? null
    })
  }

  /** Consume a `message:system:task_*` frame. Returns false when it is not one. */
  observeSystemFrame(message: Record<string, unknown>): boolean {
    const frame = readClaudeSubagentTaskFrame(message)
    if (!frame) {
      return false
    }
    this.announcesTasks ||= frame.announcement
    if (frame.excluded) {
      // Child traffic may already have built a provisional row under the tool id;
      // the announcement is the first frame that says it is not a subagent.
      for (const id of [frame.taskId, frame.toolUseId]) {
        if (id !== null) {
          this.ids.exclude(id)
          this.remove(id)
        }
      }
      return true
    }
    if (this.ids.isExcluded(frame.taskId, frame.toolUseId)) {
      return true
    }
    if (frame.toolUseId) {
      this.ids.alias(frame.toolUseId, frame.taskId)
    }
    if (
      this.groups.hasSettled(frame.taskId, frame.toolUseId) &&
      (frame.toolUseId !== null || !this.groups.locate(frame.taskId))
    ) {
      return true
    }
    const located =
      this.groups.locateOrInherit(frame.taskId) ??
      (frame.toolUseId ? this.adopt(frame.toolUseId, frame.taskId) : null)
    if (!located) {
      if (frame.announcesSubagent) {
        this.create(
          frame.taskId,
          frame.label,
          frame.state ?? 'working',
          frame.backgrounded ?? false,
          frame.toolUseId
        )
      }
      return true
    }
    const tracked = located.group.entries.get(frame.taskId)
    if (tracked && !applyClaudeSubagentInvocation(tracked, frame, this.now)) {
      return true
    }
    this.revise(located.group, frame.taskId, {
      label: frame.label,
      state: frame.state,
      backgrounded: frame.backgrounded
    })
    return true
  }

  /**
   * A frame carrying `parent_tool_use_id` — the child's own traffic. It refreshes
   * nothing on an announced child; it exists so a CLI release that sends no task
   * frames still shows the subagent it is running.
   */
  observeChildActivity(parentToolUseId: string): void {
    const canonical = this.ids.canonical(parentToolUseId)
    if (
      this.ids.isExcluded(parentToolUseId, canonical) ||
      this.groups.hasSettled(canonical, parentToolUseId) ||
      (!this.groups.locate(canonical) && this.groups.hasSettled(canonical, null))
    ) {
      return
    }
    if (this.groups.locate(canonical)) {
      return
    }
    const inherited = this.groups.locateOrInherit(canonical)
    if (inherited) {
      // Child traffic can precede the announcement that reopens an inherited row.
      this.groups.trim(inherited.group, true)
      return
    }
    if (this.announcesTasks) {
      // A nested Task, a workflow child, or a grandchild parented to a tool id
      // inside the sidechain all reach here. This CLI announces what it spawns,
      // so an id it never declared cannot be a subagent — and a row invented for
      // one is unlabelled forever and can only ever end `unverifiable`. The
      // bounded exclusion set cannot cover an id that was never announced.
      return
    }
    if (!isBoundedClaudeTaskId(canonical)) {
      // `claudeTaskId` rejects an over-long announced id rather than truncating
      // it; a provisional id becomes the same durable entry key, so it cannot
      // enter under a looser rule.
      return
    }
    this.create(canonical, null, 'working', false, parentToolUseId)
  }

  /**
   * The parent turn's tool result for a spawn call. It settles a foreground
   * child, whose result IS the turn's evidence the child finished. A backgrounded
   * child's spawn call returns immediately while the child keeps running, so its
   * result proves nothing and is ignored.
   */
  observeToolResult(toolUseId: string, failed: boolean): void {
    const canonical = this.ids.canonical(toolUseId)
    const located = this.groups.locate(canonical)
    if (
      !located ||
      located.tracked.invocationIds === null ||
      located.tracked.backgrounded ||
      (located.tracked.toolUseId !== null && located.tracked.toolUseId !== toolUseId)
    ) {
      return
    }
    this.revise(located.group, canonical, {
      label: null,
      state: failed ? 'failed' : 'completed',
      backgrounded: false
    })
  }

  /**
   * The parent turn ended. A foreground child still reported as working will
   * never be settled by an event, so it becomes `unverifiable`: contact was
   * lost, which is NOT evidence the child exited. A backgrounded child was
   * explicitly told to outlive the turn and is left alone.
   */
  settleTurn(groupKey: string | null): void {
    // Only the group this key names. `OUTSIDE_TURN` belongs to no turn, so an
    // unrelated turn ending is no evidence about a child announced outside it.
    // `settleSession` reaches what no turn does.
    this.sweep(this.groups.get(groupKey ?? OUTSIDE_TURN), false)
    this.deps.onIdentitiesFinal?.()
  }

  /** The provider is gone. Nothing more will arrive for any child, backgrounded
   *  or not, so every one of them loses contact at once. */
  settleSession(): void {
    for (const group of this.groups.values()) {
      this.sweep(group, true)
    }
    this.deps.onIdentitiesFinal?.()
  }

  dispose(): void {
    // Teardown paths reach here without an `ended` event, so a row still
    // reporting `working` would have nothing left to revise it. A session that
    // did settle first leaves every child terminal, so this writes nothing.
    this.settleSession()
    this.groups.clear()
    this.ids.clear()
    this.announcesTasks = false
  }

  private sweep(group: RosterGroup | undefined, includeBackgrounded: boolean): void {
    if (!group) {
      return
    }
    for (const [id, tracked] of group.entries) {
      if (isTerminalSubagentState(tracked.entry.state)) {
        continue
      }
      if (tracked.backgrounded && !includeBackgrounded) {
        continue
      }
      group.entries.set(id, {
        ...tracked,
        entry: { ...tracked.entry, state: 'unverifiable', settledAt: this.now() }
      })
    }
    this.write(group)
  }

  private write(group: RosterGroup): void {
    writeClaudeSubagentGroupRow(this.deps.sink, group)
    this.groups.trim(group)
  }

  private create(
    id: string,
    label: string | null,
    state: NativeChatSubagentEntry['state'],
    backgrounded: boolean,
    toolUseId: string | null
  ): void {
    const group = this.groups.groupFor(this.deps.currentGroupKey() ?? OUTSIDE_TURN)
    if (group.admittedEntries >= MAX_SUBAGENTS_PER_GROUP) {
      this.write(group)
      return
    }
    group.admittedEntries += 1
    const now = this.now()
    const labelBase = label ?? UNLABELLED_AGENT
    group.entries.set(id, {
      backgrounded,
      toolUseId,
      invocationIds: new Set(toolUseId ? [toolUseId] : []),
      labelBase,
      attempt: 1,
      invokedInEarlierRun: false,
      entry: {
        id,
        label: claimClaudeSubagentLabel(group, labelBase),
        state,
        startedAt: now,
        ...(isTerminalSubagentState(state) ? { settledAt: now } : {})
      }
    })
    this.groups.place(id, group.groupId)
    this.write(group)
  }

  private revise(
    group: RosterGroup,
    id: string,
    change: {
      label: string | null
      state: NativeChatSubagentEntry['state'] | null
      backgrounded: boolean | null
    }
  ): void {
    const tracked = group.entries.get(id)
    if (!tracked) {
      return
    }
    const next: TrackedEntry = {
      ...tracked,
      backgrounded: change.backgrounded ?? tracked.backgrounded,
      entry: { ...tracked.entry }
    }
    // A provisional row built from child traffic takes the real name the first
    // announcement carries; an announced row keeps the name it was given.
    if (
      change.label &&
      tracked.labelBase === UNLABELLED_AGENT &&
      change.label !== UNLABELLED_AGENT
    ) {
      next.labelBase = change.label
      next.entry.label = claimClaudeSubagentLabel(group, change.label)
    }
    // Proven outcomes latch; lost contact can still receive a later verdict.
    if (change.state && canReplaceSubagentState(tracked.entry.state, change.state)) {
      next.entry.state = change.state
      if (isTerminalSubagentState(change.state)) {
        // An earlier run's child ended with that run, so this verdict says how, not
        // when; a run that died unswept left no time, and now is not it.
        next.entry.settledAt = tracked.invokedInEarlierRun ? tracked.entry.settledAt : this.now()
      }
    }
    group.entries.set(id, next)
    this.write(group)
  }

  /** Re-key a provisional entry from its tool id onto the canonical task id the
   *  announcement finally named, so the child does not appear twice. */
  private adopt(toolUseId: string, taskId: string): { group: RosterGroup } | null {
    if (toolUseId === taskId) {
      return null
    }
    const located = this.groups.locate(toolUseId)
    if (!located) {
      return null
    }
    located.group.entries.delete(toolUseId)
    located.group.entries.set(taskId, {
      ...located.tracked,
      entry: { ...located.tracked.entry, id: taskId }
    })
    this.groups.forget(toolUseId)
    this.groups.place(taskId, located.group.groupId)
    return { group: located.group }
  }

  private remove(id: string): void {
    const located = this.groups.locate(id)
    if (!located) {
      return
    }
    located.group.entries.delete(id)
    this.groups.forget(id)
    this.write(located.group)
  }
}
