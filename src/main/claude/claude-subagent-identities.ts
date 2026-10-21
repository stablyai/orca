// Which Claude subagent a frame belongs to, read from Claude's task frames.
//
// The host's child records decide what every subagent is doing and what its saved row says; the
// task-frame decoder is what feeds them. This only names children, so each row a child writes is
// filed under it: `task_id` is the key, and each `tool_use_id` is one run of it, since Claude
// re-announces a resumed task under a NEW tool id. An announcement that a task is not a subagent
// is remembered too, so later frames for it are never read as a subagent's.

import { BoundedMap } from '../../shared/bounded-map'
import { ClaudeSubagentIds } from './claude-subagent-id-aliases'
import type { ClaudeJournaledSubagents } from './claude-subagent-journaled-identities'
import {
  ClaudeSubagentLinkage,
  type ClaudeAgentLinkageSource,
  type ClaudeSubagentLinkageSource
} from './claude-subagent-linkage'
import { readClaudeSubagentTaskFrame } from './claude-subagent-task-frames'

/** Children whose current run attribution remembers; an older one's rows read as its first run. */
const MAX_KNOWN_SUBAGENTS = 1024

type KnownSubagent = { run: string | null; attempt: number }

export type ClaudeSubagentIdentitiesDeps = {
  /** Whether a tool id was forwarded at the TOP level. A child parented to one
   *  was spawned by a call the transcript shows, so its announcement is still
   *  expected; a child parented to anything else names an id that only ever
   *  existed inside a sidechain, which this CLI will never announce. */
  isForwardedParentTool?: (toolUseId: string) => boolean
  /** The reference naming the child that journaled a tool call, when a child
   *  did. It is how a grandchild's row reaches the agent that spawned it. */
  childOwnerRefOf?: (toolUseId: string) => string | null
  /** What earlier provider runs of this session journaled. */
  journaled?: ClaudeJournaledSubagents
}

export class ClaudeSubagentIdentities {
  private readonly ids: ClaudeSubagentIds
  private readonly known = new BoundedMap<string, KnownSubagent>({
    maxEntries: MAX_KNOWN_SUBAGENTS
  })
  /** Who produced a row, for every write site journaling this session. */
  readonly linkage: ClaudeSubagentLinkageSource & ClaudeAgentLinkageSource

  constructor(private readonly deps: ClaudeSubagentIdentitiesDeps) {
    this.ids = new ClaudeSubagentIds(deps.journaled?.canonical)
    this.linkage = new ClaudeSubagentLinkage({
      ids: this.ids,
      trackedFor: (canonicalId) => {
        const attempt =
          this.known.get(canonicalId)?.attempt ?? deps.journaled?.attempt(canonicalId) ?? 0
        return attempt > 0 ? { attempt } : null
      },
      isForwardedParentTool: deps.isForwardedParentTool,
      childOwnerRefOf: deps.childOwnerRefOf,
      spawnRefOf: (canonicalId) => this.known.get(canonicalId)?.run ?? null
    })
  }

  /** Consume a `message:system:task_*` frame. Returns false when it is not one. */
  observeSystemFrame(message: Record<string, unknown>): boolean {
    const frame = readClaudeSubagentTaskFrame(message)
    if (!frame) {
      return false
    }
    if (frame.excluded) {
      for (const id of [frame.taskId, frame.toolUseId]) {
        if (id !== null) {
          this.ids.exclude(id)
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
    if (frame.announcesSubagent) {
      this.announce(frame.taskId, frame.toolUseId)
    }
    return true
  }

  dispose(): void {
    this.ids.clear()
    this.known.clear()
  }

  /** A new spawn call is the child's next run; one an earlier provider process ran it under was
   *  that process's, so this run follows the last one its rows record. */
  private announce(taskId: string, run: string | null): void {
    const known = this.known.get(taskId)
    if (known && (run === null || run === known.run)) {
      return
    }
    const previous = known?.attempt ?? this.deps.journaled?.attempt(taskId) ?? 0
    this.known.set(taskId, { run, attempt: previous + 1 })
  }
}
