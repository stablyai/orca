import { agentJournalLinkageFields } from '../../shared/agent-session-journal-producer'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  createAgentSessionDeltaCoalescer,
  type AgentSessionDeltaCoalescerDeps
} from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { ClaudeSubagentLinkageSource } from './claude-subagent-linkage'

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
  /** Coalesce deltas and widen checkpoint intervals to avoid per-token journal rewrites. */
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

  /** Resolve each checkpoint afresh; later announcements revise provisional producers on the same row. */
  const producerOptions = (key: string): StructuredAgentSessionAppendOptions => {
    const scope = scopes.get(key) ?? null
    if (scope === null) {
      return {}
    }
    return agentJournalLinkageFields(deps.producer.settledLinkageFor(scope).linkage)
  }

  const persist = (key: string, text: string, force: boolean): void => {
    latestText.set(key, text)
    const checkpointLength = checkpointLengths.get(key) ?? 0
    const nextLength = Math.max(checkpointLength + 32, Math.ceil(checkpointLength * 1.125))
    if (!force && checkpointLength > 0 && text.length < nextLength) {
      return
    }
    const identity = identities.get(key)
    if (!identity) {
      return
    }
    const options = producerOptions(key)
    checkpointLengths.set(key, text.length)
    writtenLinkage.set(key, options)
    deps.persist(identity, text, options)
  }

  const coalescer = createAgentSessionDeltaCoalescer({
    ...(deps.coalesceMs === undefined ? {} : { windowMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    emit: (key, text) => persist(key, text, false)
  })

  const drop = (key: string): void => {
    coalescer.forget(key)
    identities.delete(key)
    scopes.delete(key)
    writtenLinkage.delete(key)
    latestText.delete(key)
    checkpointLengths.delete(key)
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
      for (const [key, text] of latestText) {
        if (checkpointLengths.get(key) !== text.length) {
          persist(key, text, true)
        }
      }
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
        coalescer.flush(key)
        const text = latestText.get(key)
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
    }
  }
}
