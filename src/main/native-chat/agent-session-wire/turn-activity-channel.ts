import {
  agentSessionTurnActivityEqual,
  type AgentSessionOpenReasoning,
  type AgentSessionTurnActivity
} from '../../../shared/agent-session-turn-activity'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'

/** Bounds the published list; a turn running more reasoning subagents at once is not plausible. */
export const MAX_OPEN_REASONING_SUBAGENTS = 32

const NOTHING_OPEN: AgentSessionOpenReasoning = { session: false, subagents: [] }

export type TurnActivityChannel = {
  /** The provider's words for the turn: '' or null clears them, undefined leaves them. */
  setText: (turnId: string, text: string | null | undefined) => void
  /** Who has reasoning open in the turn, as the provider's tracker last derived it. */
  setReasoning: (turnId: string | null, reasoning: AgentSessionOpenReasoning) => void
  /** The turn ended or a new one opened: nothing it said is current any more. */
  clear: () => void
  /** Runs one provider event's updates, publishing their net result once at the end: an item that
   *  clears its words and closes its reasoning must not show the half-way state between them. */
  batch: <T>(run: () => T) => T
}

function isOpen(reasoning: AgentSessionOpenReasoning): boolean {
  return reasoning.session || reasoning.subagents.length > 0
}

/** One turn's live activity line, composed from the provider's words and its open reasoning, so
 *  neither writer overwrites the other. */
export function createTurnActivityChannel(
  sink: Pick<StructuredAgentSessionEventSink, 'setActivity'>
): TurnActivityChannel {
  let turnId: string | null = null
  let text = ''
  let reasoning = NOTHING_OPEN
  let published: AgentSessionTurnActivity | null = null
  let batching = false
  /** Inside a batch: whether anything asked to publish, and whether any of it had to be sent. */
  let owed: { force: boolean } | null = null

  const retarget = (next: string): void => {
    if (next !== turnId) {
      turnId = next
      text = ''
      reasoning = NOTHING_OPEN
    }
  }
  const publish = (force = false): void => {
    if (batching) {
      owed = { force: force || owed?.force === true }
      return
    }
    const next: AgentSessionTurnActivity | null =
      turnId !== null && (text || isOpen(reasoning))
        ? { turnId, text, ...(isOpen(reasoning) ? { reasoning } : {}) }
        : null
    if (force || !agentSessionTurnActivityEqual(next, published)) {
      published = next
      sink.setActivity?.(next)
    }
  }

  return {
    setText: (next, value) => {
      if (value === undefined) {
        return
      }
      retarget(next)
      text = value ?? ''
      // A cleared line is always sent, as before: an attach may still hold an earlier one.
      publish(!value)
    },
    setReasoning: (next, value) => {
      if (next === null) {
        if (isOpen(reasoning)) {
          reasoning = NOTHING_OPEN
          publish()
        }
        return
      }
      retarget(next)
      reasoning = {
        session: value.session,
        subagents: [...new Set(value.subagents)].sort().slice(0, MAX_OPEN_REASONING_SUBAGENTS)
      }
      publish()
    },
    clear: () => {
      turnId = null
      text = ''
      reasoning = NOTHING_OPEN
      publish(true)
    },
    batch: (run) => {
      if (batching) {
        return run()
      }
      batching = true
      try {
        return run()
      } finally {
        batching = false
        const due = owed
        owed = null
        if (due) {
          publish(due.force)
        }
      }
    }
  }
}
