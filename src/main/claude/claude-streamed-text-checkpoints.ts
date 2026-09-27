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
  /** Rewrites the block's journal row with the text accumulated so far. */
  persist: (
    identity: AgentJournalItemIdentity,
    text: string,
    options: StructuredAgentSessionAppendOptions
  ) => void
  /** Who produced a block, asked by the scope the block streamed under. */
  producer: ClaudeSubagentLinkageSource
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

export type ClaudeStreamedTextCheckpoints = {
  /** Accumulate a delta; the row is rewritten on the coalescer's own cadence. */
  append: (
    identity: AgentJournalItemIdentity,
    text: string,
    parentToolUseId?: string | null
  ) => void
  /** Write every block whose row is behind the text received for it. */
  flush: () => void
  /** Rewrite every block whose producer now resolves differently. A block that
   *  stopped streaming before its announcement is never revisited otherwise,
   *  and would keep a provisional id no later checkpoint comes to correct. */
  reattribute: () => void
  /** Drop one block's state, for a block whose final frame has now landed. */
  forget: (key: string) => void
  /**
   * Drop every block still awaiting its final frame, at turn settlement. Their
   * text is already journaled by the flush that precedes settlement; keeping it
   * live would grow with every interrupted turn for the life of the session.
   */
  settle: () => void
  /** Blocks still awaiting a final frame. A settled turn must leave none. */
  readonly pending: number
  dispose: () => void
}

/**
 * Growth of a streamed block's row between its deltas and its final frame.
 *
 * The row is rewritten on a widening interval rather than per delta: a 200-line
 * reply would otherwise rewrite the same journal row once per token.
 */
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
  /** The scope a block streamed under, kept because the persist callback has no
   *  frame to re-read it from. */
  const scopes = new Map<string, string | null>()
  /** What each block's row was last written WITH — never a latch on resolving
   *  it again. Every checkpoint rewrites the same identity, so a block has one
   *  row and re-resolving can only revise it; this exists so a re-attribution
   *  that would change nothing does not burn a revision. */
  const writtenLinkage = new Map<string, StructuredAgentSessionAppendOptions>()
  const latestText = new Map<string, string>()
  const checkpointLengths = new Map<string, number>()

  /** Resolved FRESH on every checkpoint. A provisional producer is stamped with
   *  the handle it has rather than holding the prose back: the next checkpoint,
   *  or `reattribute` once the announcement lands, revises the same row. */
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
        // Nothing resolved differently: a duplicate must not burn a revision.
        if (written && sameLinkage(written, options)) {
          continue
        }
        writtenLinkage.set(key, options)
        deps.persist(identity, text, options)
      }
    },
    forget: drop,
    settle: () => {
      // Map iteration tolerates deletion of the entry just visited.
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
