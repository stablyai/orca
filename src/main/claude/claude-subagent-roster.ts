// The Claude subagent roster: one journal row per turn that spawned children.
//
// Entries are built from `task_started`, never from child traffic: a
// BACKGROUNDED subagent emits no child frames at all, so a roster fed by
// `parent_tool_use_id` alone would leave every one of them an unlabelled row
// forever. Child traffic only creates an entry for CLI releases that announce
// no task frames.
//
// Claude re-announces a resumed task under a NEW `tool_use_id`, so `task_id` is
// the key and each tool id is one run of it; keying on the tool id would
// duplicate the child on every resume. Everything the row says follows the
// shared subagent tracker's rules; this module only reads Claude's frames.

import type { AgentJournalTurnScope } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { subagentRowSinkPort } from '../native-chat/subagent-tracker/subagent-row-sink-port'
import { SubagentTracker } from '../native-chat/subagent-tracker/subagent-tracker'
import type { SubagentReport } from '../native-chat/subagent-tracker/subagent-tracker-types'
import { isBoundedClaudeTaskId } from './claude-background-task-tracker'
import { ClaudeSubagentIds } from './claude-subagent-id-aliases'
import {
  claudeSubagentGroupIdentity,
  type ClaudeJournaledRosterSource
} from './claude-subagent-journaled-roster'
import {
  ClaudeSubagentLinkage,
  type ClaudeAgentLinkageSource,
  type ClaudeSubagentLinkageSource
} from './claude-subagent-linkage'
import { readClaudeSubagentTaskFrame } from './claude-subagent-task-frames'

/** The turn a group belongs to when Claude reports a task outside any turn. */
const OUTSIDE_TURN = 'outside-turn'

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
  private readonly tracker: SubagentTracker<AgentJournalTurnScope>
  private readonly ids: ClaudeSubagentIds
  /** Who produced a row, for every write site journaling this session. */
  readonly linkage: ClaudeSubagentLinkageSource & ClaudeAgentLinkageSource
  /** Set by ANY `task_started`, including one the subagent filter rejects. Once
   *  this CLI has proven it declares its tasks, child traffic for an id it never
   *  announced is a nested tool or a grandchild, not a subagent. */
  private announcesTasks = false

  constructor(private readonly deps: ClaudeSubagentRosterDeps) {
    this.tracker = new SubagentTracker({
      port: subagentRowSinkPort(deps.sink, claudeSubagentGroupIdentity),
      ...(deps.journaled ? { journaled: deps.journaled } : {}),
      ...(deps.now ? { now: deps.now } : {})
    })
    this.ids = new ClaudeSubagentIds(deps.journaled?.canonical)
    this.linkage = new ClaudeSubagentLinkage({
      ids: this.ids,
      trackedFor: (canonicalId) =>
        this.tracker.locate(canonicalId) ? { attempt: this.tracker.attempt(canonicalId) } : null,
      isForwardedParentTool: deps.isForwardedParentTool,
      childOwnerRefOf: deps.childOwnerRefOf,
      spawnRefOf: (canonicalId) => this.tracker.locate(canonicalId)?.tracked.run ?? null
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
          this.tracker.remove(id)
        }
      }
      return true
    }
    if (this.ids.isExcluded(frame.taskId, frame.toolUseId)) {
      return true
    }
    if (frame.toolUseId) {
      this.ids.alias(frame.toolUseId, frame.taskId)
      if (!this.tracker.locate(frame.taskId)) {
        // A provisional row built under the tool id takes the canonical id the announcement names.
        this.tracker.rekey(frame.toolUseId, frame.taskId)
      }
    }
    this.tracker.report({
      id: frame.taskId,
      ...(frame.toolUseId ? { run: frame.toolUseId } : {}),
      group: this.currentGroup(),
      announces: frame.announcesSubagent,
      label: frame.label,
      state: frame.state,
      ...(frame.backgrounded !== null ? { backgrounded: frame.backgrounded } : {})
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
      this.tracker.hasSettled(canonical, parentToolUseId)
    ) {
      return
    }
    const located = this.tracker.locate(canonical)
    if (located) {
      // Child traffic can precede the announcement that reopens an inherited row.
      if (located.tracked.inherited) {
        this.tracker.retain(located.group)
      }
      return
    }
    if (
      this.tracker.hasSettled(canonical, null) ||
      // This CLI announces what it spawns, so an id it never declared is a nested
      // Task, a workflow child, or a grandchild — not a subagent. A row invented
      // for one is unlabelled forever and can only ever end `unverifiable`.
      this.announcesTasks ||
      // A provisional id becomes the same durable entry key, so it takes the
      // bound an announced id does.
      !isBoundedClaudeTaskId(canonical)
    ) {
      return
    }
    this.tracker.report({
      id: canonical,
      run: parentToolUseId,
      group: this.currentGroup(),
      announces: true,
      state: 'working'
    })
  }

  /**
   * The parent turn's tool result for a spawn call. It settles a foreground
   * child, whose result IS the turn's evidence the child finished. A backgrounded
   * child's spawn call returns immediately while the child keeps running, so its
   * result proves nothing and is ignored.
   */
  observeToolResult(toolUseId: string, failed: boolean): void {
    const canonical = this.ids.canonical(toolUseId)
    const located = this.tracker.locate(canonical)
    if (
      !located ||
      located.tracked.backgrounded ||
      (located.tracked.run !== null && located.tracked.run !== toolUseId)
    ) {
      return
    }
    this.tracker.report({
      id: canonical,
      run: toolUseId,
      group: this.currentGroup(),
      announces: false,
      state: failed ? 'failed' : 'completed'
    })
  }

  /** The parent turn ended. A foreground child still working loses contact with
   *  it; a backgrounded one was told to outlive the turn. Only the group this key
   *  names: `OUTSIDE_TURN` belongs to no turn, so no turn's end says anything about it. */
  settleTurn(groupKey: string | null): void {
    this.tracker.settleTurn(groupKey ?? OUTSIDE_TURN)
    this.deps.onIdentitiesFinal?.()
  }

  /** The provider is gone. Nothing more will arrive for any child, backgrounded
   *  or not, so every one of them loses contact at once. */
  settleSession(): void {
    this.tracker.settleSession()
    this.deps.onIdentitiesFinal?.()
  }

  dispose(): void {
    // Teardown paths reach here without an `ended` event; a session that did
    // settle first leaves every child terminal, so this writes nothing.
    this.settleSession()
    this.tracker.dispose()
    this.ids.clear()
    this.announcesTasks = false
  }

  private currentGroup(): SubagentReport<AgentJournalTurnScope>['group'] {
    return {
      id: this.deps.currentGroupKey() ?? OUTSIDE_TURN,
      placement: this.deps.currentTurnScope
    }
  }
}
