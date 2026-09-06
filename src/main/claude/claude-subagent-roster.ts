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
// child on every resume. Every transition is idempotent and a terminal state
// latches, because progress, updates and the parent's tool result can each
// report the same outcome.

import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { isTerminalSubagentState } from '../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { isBoundedClaudeTaskId } from './claude-background-task-tracker'
import { claudeSubagentGroupBody, claudeSubagentGroupIdentity } from './claude-subagent-group-row'
import { ClaudeSubagentIds } from './claude-subagent-id-aliases'
import { readClaudeSubagentTaskFrame } from './claude-subagent-task-frames'

/** Spawn-group rows kept live per session, and children per row. Both bound an
 *  event-accumulated map that no provider snapshot ever prunes. */
const MAX_SUBAGENT_GROUPS = 32
const MAX_SUBAGENTS_PER_GROUP = 64

/** The turn a group belongs to when Claude reports a task outside any turn. */
const OUTSIDE_TURN = 'outside-turn'

const UNLABELLED_AGENT = 'subagent'

type TrackedEntry = {
  entry: NativeChatSubagentEntry
  /** The only signal separating a child that dies with its turn from one told to
   *  outlive it. A turn-end sweep must leave a backgrounded child alone. */
  backgrounded: boolean
  /** Label before its ordinal suffix, so a later announcement can tell a
   *  provisional row from one that already carries the provider's own name. */
  labelBase: string
}

type RosterGroup = {
  groupId: string
  identity: AgentJournalItemIdentity
  /** Insertion order is the display order; the map holds the state. */
  entries: Map<string, TrackedEntry>
  /** Every RENDERED label this group has handed out. Nothing releases one:
   *  re-issuing a label would print two identical rows. Growing it past the
   *  entry cap takes a stream that re-announces a rostered agent as a shell
   *  task, which churns the row far harder than the set. */
  claimedLabels: Set<string>
  /** Last body written, so an idempotent replay writes no new revision. */
  lastSerialized: string | null
}

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
        this.create(frame.taskId, frame.label, frame.state ?? 'working', frame.backgrounded)
      }
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
    this.create(canonical, null, 'working', false)
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
    if (!located || located.tracked.backgrounded) {
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
    // unrelated turn ending is no evidence about a child announced outside it —
    // and `unverifiable` latches, so sweeping it there would swallow the
    // `completed` that still arrives. `settleSession` reaches what no turn does.
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
    backgrounded: boolean
  ): void {
    const group = this.groupFor()
    if (group.entries.size >= MAX_SUBAGENTS_PER_GROUP) {
      return
    }
    const now = this.now()
    const labelBase = label ?? UNLABELLED_AGENT
    group.entries.set(id, {
      backgrounded,
      labelBase,
      entry: {
        id,
        label: this.claimLabel(group, labelBase),
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
      backgrounded: boolean
    }
  ): void {
    const tracked = group.entries.get(id)
    if (!tracked) {
      return
    }
    const next: TrackedEntry = {
      ...tracked,
      backgrounded: tracked.backgrounded || change.backgrounded,
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
      next.entry.label = this.claimLabel(group, change.label)
    }
    // Terminal latches: a duplicate or out-of-order frame must not resurrect a
    // settled child, and re-applying a live state is a no-op.
    if (change.state && !isTerminalSubagentState(tracked.entry.state)) {
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

  /** Two children can share a description; the ordinal keeps their rows apart
   *  without inventing a name the provider never sent. The probe is over the
   *  labels actually rendered, not a per-base counter: a generated `Audit 2`
   *  must not collide with a provider that names its own child `Audit 2`. */
  private claimLabel(group: RosterGroup, base: string): string {
    let candidate = base
    for (let ordinal = 2; group.claimedLabels.has(candidate); ordinal++) {
      candidate = `${base} ${ordinal}`
    }
    group.claimedLabels.add(candidate)
    return candidate
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
