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

import {
  canReplaceSubagentState,
  isTerminalSubagentState
} from '../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { isBoundedClaudeTaskId } from './claude-background-task-tracker'
import { claudeSubagentGroupBody, claudeSubagentGroupIdentity } from './claude-subagent-group-row'
import { ClaudeSubagentIds } from './claude-subagent-id-aliases'
import { readClaudeSubagentTaskFrame } from './claude-subagent-task-frames'
import {
  applyClaudeSubagentInvocation,
  claimClaudeSubagentLabel,
  type RosterGroup,
  type TrackedEntry
} from './claude-subagent-roster-state'

/** Spawn-group rows kept live per session, and children per row. Both bound an
 *  event-accumulated map that no provider snapshot ever prunes. */
const MAX_SUBAGENT_GROUPS = 32
const MAX_SUBAGENTS_PER_GROUP = 64

/** The turn a group belongs to when Claude reports a task outside any turn. */
const OUTSIDE_TURN = 'outside-turn'

const UNLABELLED_AGENT = 'subagent'

export type ClaudeSubagentRosterDeps = {
  sink: StructuredAgentSessionEventSink
  /** The turn that owns children spawned right now; null outside any turn. */
  currentGroupKey: () => string | null
  now?: () => number
}

export class ClaudeSubagentRoster {
  private readonly groups = new Map<string, RosterGroup>()
  /** Canonical id → the group holding its entry, so a late update for a child
   *  from an earlier turn revises that turn's row instead of the live one. */
  private readonly groupIdByEntry = new Map<string, string>()
  private readonly ids = new ClaudeSubagentIds()
  /** Set by ANY `task_started`, including one the subagent filter rejects. Once
   *  this CLI has proven it declares its tasks, child traffic for an id it never
   *  announced is a nested tool or a grandchild, not a subagent. */
  private announcesTasks = false
  private readonly now: () => number

  constructor(private readonly deps: ClaudeSubagentRosterDeps) {
    this.now = deps.now ?? (() => Date.now())
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
    const located =
      this.locate(frame.taskId) ??
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
    if (this.ids.isExcluded(parentToolUseId, canonical)) {
      return
    }
    if (this.locate(canonical)) {
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
    const located = this.locate(canonical)
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
  }

  /** The provider is gone. Nothing more will arrive for any child, backgrounded
   *  or not, so every one of them loses contact at once. */
  settleSession(): void {
    for (const group of this.groups.values()) {
      this.sweep(group, true)
    }
  }

  dispose(): void {
    // Teardown paths reach here without an `ended` event, so a row still
    // reporting `working` would have nothing left to revise it. A session that
    // did settle first leaves every child terminal, so this writes nothing.
    this.settleSession()
    this.groups.clear()
    this.groupIdByEntry.clear()
    this.ids.clear()
    this.announcesTasks = false
  }

  private sweep(group: RosterGroup | undefined, includeBackgrounded: boolean): void {
    if (!group) {
      return
    }
    let changed = false
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
      changed = true
    }
    if (changed) {
      this.write(group)
    }
  }

  private create(
    id: string,
    label: string | null,
    state: NativeChatSubagentEntry['state'],
    backgrounded: boolean,
    toolUseId: string | null
  ): void {
    const group = this.groupFor()
    if (group.admittedEntries >= MAX_SUBAGENTS_PER_GROUP) {
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
      entry: {
        id,
        label: claimClaudeSubagentLabel(group, labelBase),
        state,
        startedAt: now,
        ...(isTerminalSubagentState(state) ? { settledAt: now } : {})
      }
    })
    this.groupIdByEntry.set(id, group.groupId)
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
        next.entry.settledAt = this.now()
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
    const located = this.locate(toolUseId)
    if (!located) {
      return null
    }
    located.group.entries.delete(toolUseId)
    located.group.entries.set(taskId, {
      ...located.tracked,
      entry: { ...located.tracked.entry, id: taskId }
    })
    this.groupIdByEntry.delete(toolUseId)
    this.groupIdByEntry.set(taskId, located.group.groupId)
    return { group: located.group }
  }

  private remove(id: string): void {
    const located = this.locate(id)
    if (!located) {
      return
    }
    located.group.entries.delete(id)
    this.groupIdByEntry.delete(id)
    this.write(located.group)
  }

  private locate(id: string): { group: RosterGroup; tracked: TrackedEntry } | null {
    const groupId = this.groupIdByEntry.get(id)
    const group = groupId === undefined ? undefined : this.groups.get(groupId)
    const tracked = group?.entries.get(id)
    return group && tracked ? { group, tracked } : null
  }

  private groupFor(): RosterGroup {
    const groupId = this.deps.currentGroupKey() ?? OUTSIDE_TURN
    const existing = this.groups.get(groupId)
    if (existing) {
      return existing
    }
    const group: RosterGroup = {
      groupId,
      identity: claudeSubagentGroupIdentity(groupId),
      entries: new Map(),
      admittedEntries: 0,
      claimedLabels: new Set(),
      lastSerialized: null
    }
    this.groups.set(groupId, group)
    while (this.groups.size > MAX_SUBAGENT_GROUPS) {
      const oldest = this.groups.keys().next()
      if (oldest.done || oldest.value === groupId) {
        break
      }
      const evicted = this.groups.get(oldest.value)
      // Once the group leaves the map nothing can reach its children again —
      // not even a session sweep — so contact is lost here.
      this.sweep(evicted, true)
      for (const id of evicted?.entries.keys() ?? []) {
        this.groupIdByEntry.delete(id)
      }
      this.groups.delete(oldest.value)
    }
    return group
  }

  private write(group: RosterGroup): void {
    const agents = [...group.entries.values()].map((tracked) => tracked.entry)
    const options = { coalescingKey: `claude-subagents:${group.groupId}` }
    if (agents.length === 0) {
      // The row's last child turned out not to be a subagent. An empty roster is
      // not a roster of nothing, so the row goes rather than reading "Ran 0".
      if (group.lastSerialized !== null) {
        group.lastSerialized = null
        this.deps.sink.appendTombstone(group.identity, options)
        this.deps.sink.publish()
      }
      return
    }
    const body = claudeSubagentGroupBody(group.groupId, agents)
    const serialized = JSON.stringify(body)
    if (serialized === group.lastSerialized) {
      // Nothing changed — a duplicate delivery must not burn a revision.
      return
    }
    group.lastSerialized = serialized
    this.deps.sink.appendItem(group.identity, body, options)
    // Publish keeps the sink's own coalescing slot: sharing the row's key makes
    // each queued publish evict the append it was meant to flush.
    this.deps.sink.publish()
  }
}
