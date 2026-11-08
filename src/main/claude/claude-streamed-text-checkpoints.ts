import { agentJournalLinkageFields } from '../../shared/agent-session/journal/agent-session-journal-producer'
import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionAppendOptions } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  createAgentSessionDeltaCoalescer,
  type AgentSessionDeltaCoalescerDeps
} from '../native-chat/agent-session-wire/publication/subscribers/agent-session-delta-coalescer'
import type { ClaudeSubagentLinkageSource } from './claude-subagent-linkage'

/** Longest a growing block waits for its next save when the growth gate has not opened. */
export const CLAUDE_STREAMED_TEXT_STALENESS_CAP_MS = 2_000

export type ClaudeStreamedTextCheckpointDeps = {
  /** Rewrite accumulated text; ended marks the last write when no final frame will arrive. */
  persist: (
    identity: AgentJournalItemIdentity,
    text: string,
    options: StructuredAgentSessionAppendOptions,
    ended?: ClaudeStreamedBlockEnd
  ) => void
  producer: ClaudeSubagentLinkageSource
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

/** Host time of completion or interruption. */
export type ClaudeStreamedBlockEnd = { completedAt?: number }

export type ClaudeStreamedTextCheckpoints = {
  /** Coalesce deltas and widen checkpoint intervals, capped in time, to avoid per-token rewrites. */
  append: (
    identity: AgentJournalItemIdentity,
    text: string,
    parentToolUseId?: string | null
  ) => void
  flush: () => void
  /** Correct provisional producers even for blocks that stopped receiving checkpoints. */
  reattribute: () => void
  forget: (key: string) => void
  latest: (key: string) => string | undefined
  /** End matching rows whose final frames will never arrive; discard empty blocks. */
  finish: (ended: ClaudeStreamedBlockEnd, only?: (key: string) => boolean) => void
  /** Flush before settling; discard retained blocks so interrupted turns cannot accumulate text. */
  settle: () => void
  readonly pending: number
  dispose: () => void
}

function sameLinkage(
  left: StructuredAgentSessionAppendOptions,
  right: StructuredAgentSessionAppendOptions
): boolean {
  return (
    left.agentId === right.agentId &&
    left.parentAgentId === right.parentAgentId &&
    left.providerParentRef === right.providerParentRef &&
    left.producerKind === right.producerKind &&
    left.attempt === right.attempt
  )
}

export function createClaudeStreamedTextCheckpoints(
  deps: ClaudeStreamedTextCheckpointDeps
): ClaudeStreamedTextCheckpoints {
  const identities = new Map<string, AgentJournalItemIdentity>()
  /** Retain producer scope because persist has no frame to read. */
  const scopes = new Map<string, string | null>()
  /** Last written linkage, used only to skip revisions that change nothing. */
  const writtenLinkage = new Map<string, StructuredAgentSessionAppendOptions>()
  const latestText = new Map<string, string>()
  const checkpointLengths = new Map<string, number>()
  const savedAt = new Map<string, number>()

  /** Growth keeps total writes linear; the cap bounds how stale a long reply can look. */
  const dueIn = (key: string, textLength: number): number => {
    const checkpointLength = checkpointLengths.get(key) ?? 0
    const nextLength = Math.max(checkpointLength + 32, Math.ceil(checkpointLength * 1.125))
    const saved = savedAt.get(key)
    return checkpointLength === 0 || textLength >= nextLength || saved === undefined
      ? 0
      : saved + CLAUDE_STREAMED_TEXT_STALENESS_CAP_MS - performance.now()
  }

  /** Resolve each checkpoint afresh; later announcements revise provisional producers on the same row. */
  const producerOptions = (key: string): StructuredAgentSessionAppendOptions => {
    const scope = scopes.get(key) ?? null
    if (scope === null) {
      return {}
    }
    return agentJournalLinkageFields(deps.producer.settledLinkageFor(scope).linkage)
  }

  const persist = (key: string, text: string): void => {
    latestText.set(key, text)
    const identity = identities.get(key)
    if (!identity) {
      return
    }
    const options = producerOptions(key)
    checkpointLengths.set(key, text.length)
    savedAt.set(key, performance.now())
    writtenLinkage.set(key, options)
    deps.persist(identity, text, options)
  }

  const coalescer = createAgentSessionDeltaCoalescer({
    ...(deps.coalesceMs === undefined ? {} : { windowMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    dueIn,
    emit: (key, text) => persist(key, text)
  })

  const drop = (key: string): void => {
    coalescer.forget(key)
    identities.delete(key)
    scopes.delete(key)
    writtenLinkage.delete(key)
    latestText.delete(key)
    checkpointLengths.delete(key)
    savedAt.delete(key)
  }

  return {
    append: (identity, text, parentToolUseId = null) => {
      const key = agentJournalItemKey(identity)
      identities.set(key, identity)
      scopes.set(key, parentToolUseId)
      coalescer.append(key, text)
    },
    flush: () => {
      coalescer.flushAll()
    },
    reattribute: () => {
      for (const [key, identity] of identities) {
        const text = latestText.get(key)
        if (text === undefined) {
          continue
        }
        const options = producerOptions(key)
        const written = writtenLinkage.get(key)
        if (written && sameLinkage(written, options)) {
          continue
        }
        writtenLinkage.set(key, options)
        deps.persist(identity, text, options)
      }
    },
    forget: drop,
    latest: (key) => coalescer.snapshot(key)?.text ?? latestText.get(key),
    finish: (ended, only) => {
      for (const [key, identity] of identities) {
        if (only && !only(key)) {
          continue
        }
        // The ending save carries any buffered tail, so no running save precedes it.
        const text = coalescer.snapshot(key)?.text ?? latestText.get(key)
        if (text !== undefined) {
          deps.persist(identity, text, producerOptions(key), ended)
        }
        drop(key)
      }
    },
    settle: () => {
      for (const key of identities.keys()) {
        drop(key)
      }
    },
    get pending() {
      return identities.size
    },
    dispose: () => {
      coalescer.dispose()
      identities.clear()
      scopes.clear()
      writtenLinkage.clear()
      latestText.clear()
      checkpointLengths.clear()
      savedAt.clear()
    }
  }
}
