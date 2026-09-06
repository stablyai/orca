import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  createAgentSessionDeltaCoalescer,
  type AgentSessionDeltaCoalescerDeps
} from '../native-chat/agent-session-wire/agent-session-delta-coalescer'

export type ClaudeStreamedTextCheckpointDeps = {
  /** Rewrites the block's journal row with the text accumulated so far. */
  persist: (identity: AgentJournalItemIdentity, text: string) => void
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

export type ClaudeStreamedTextCheckpoints = {
  /** Accumulate a delta; the row is rewritten on the coalescer's own cadence. */
  append: (identity: AgentJournalItemIdentity, text: string) => void
  /** Write every block whose row is behind the text received for it. */
  flush: () => void
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
export function createClaudeStreamedTextCheckpoints(
  deps: ClaudeStreamedTextCheckpointDeps
): ClaudeStreamedTextCheckpoints {
  const identities = new Map<string, AgentJournalItemIdentity>()
  const latestText = new Map<string, string>()
  const checkpointLengths = new Map<string, number>()

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
    checkpointLengths.set(key, text.length)
    deps.persist(identity, text)
  }

  const coalescer = createAgentSessionDeltaCoalescer({
    ...(deps.coalesceMs === undefined ? {} : { windowMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    emit: (key, text) => persist(key, text, false)
  })

  const drop = (key: string): void => {
    coalescer.forget(key)
    identities.delete(key)
    latestText.delete(key)
    checkpointLengths.delete(key)
  }

  return {
    append: (identity, text) => {
      const key = agentJournalItemKey(identity)
      identities.set(key, identity)
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
      latestText.clear()
      checkpointLengths.clear()
    }
  }
}
