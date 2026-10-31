import { BoundedMap } from '../../shared/bounded-map'
import { ClaudeSubagentIds } from './claude-subagent-id-aliases'
import type { ClaudeJournaledSubagents } from './claude-subagent-journaled-identities'
import {
  ClaudeSubagentLinkage,
  type ClaudeAgentLinkageSource,
  type ClaudeSubagentLinkageSource
} from './claude-subagent-linkage'
import { readClaudeSubagentTaskFrame } from './claude-subagent-task-frames'

/** Bound live run attribution; older entries can fall back to journaled attempts. */
const MAX_KNOWN_SUBAGENTS = 1024

type KnownSubagent = { run: string | null; attempt: number }

export type ClaudeSubagentIdentitiesDeps = {
  /** Top-level spawn calls can still receive an announcement; sidechain-only calls cannot. */
  isForwardedParentTool?: (toolUseId: string) => boolean
  /** Resolve grandchildren through the child that journaled their spawn call. */
  childOwnerRefOf?: (toolUseId: string) => string | null
  journaled?: ClaudeJournaledSubagents
}

export class ClaudeSubagentIdentities {
  private readonly ids: ClaudeSubagentIds
  private readonly known = new BoundedMap<string, KnownSubagent>({
    maxEntries: MAX_KNOWN_SUBAGENTS
  })
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

  /** Count new spawn calls after the latest live or journaled attempt. */
  private announce(taskId: string, run: string | null): void {
    const known = this.known.get(taskId)
    if (known && (run === null || run === known.run)) {
      return
    }
    const previous = known?.attempt ?? this.deps.journaled?.attempt(taskId) ?? 0
    this.known.set(taskId, { run, attempt: previous + 1 })
  }
}
