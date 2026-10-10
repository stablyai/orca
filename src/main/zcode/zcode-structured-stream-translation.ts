// Accumulates ZCode `model.streaming` deltas into journal message rows.
//
// This ZCode build never upserts whole assistant messages: a reply reaches Orca
// only as deltas keyed by `assistantMessageId` with `kind: 'text_delta' |
// 'reasoning_delta'`. Each channel keys its own stream, so a message that
// streams both still yields an assistant row and a reasoning row. Journal rows
// are SNAPSHOT rewrites of the text so far (`state: 'running'`), and a turn's
// end closes every stream it left open with one completed rewrite.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { journalReasoningBody } from '../native-chat/agent-session-journal/journal-reasoning-row'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createAgentSessionDeltaCoalescer } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'

export type ZcodeStreamTranslatorDeps = {
  sink: StructuredAgentSessionEventSink
  identityFor: (messageId: string) => AgentJournalItemIdentity
  turnScopeFor: (turnId: string | undefined) => AgentJournalTurnScope
  /** Injected by tests so the delta window can be driven without real time. */
  schedule?: (run: () => void, ms: number) => () => void
}

const ZCODE_STREAM_MAX_STREAMS = 128
/** A stream only grows while its turn runs; a modest per-stream text cap bounds memory. */
const ZCODE_STREAM_MAX_RETAINED_BYTES = 1_000_000
const ZCODE_STREAM_TOTAL_MAX_BYTES = 4_000_000

/** One open streamed message: which row it writes and the turn it belongs to. */
type ZcodeStreamState = {
  identity: AgentJournalItemIdentity
  reasoning: boolean
  turnId: string | undefined
  startedAt: number
  checkpoint: number
}

const STREAM_KEY_SEPARATOR = '\u0000'

export function createZcodeStreamTranslator(deps: ZcodeStreamTranslatorDeps): {
  handleDelta: (args: {
    messageId: string
    kind: string
    delta: string
    turnId: string | undefined
    timestamp: number
  }) => StructuredAgentSessionSinkAdmission
  /** Rewrites every still-running stream of the ending turn completed, full text included. */
  endTurn: (completedAt: number) => void
  /** Drops every open stream without claiming a completion nobody saw. */
  endTurnUnproven: () => void
  /** Drops a stream whose authoritative whole-message body arrived. */
  forget: (messageId: string) => void
  dispose: () => void
} {
  const states = new Map<string, ZcodeStreamState>()

  const appendRow = (
    state: ZcodeStreamState,
    text: string,
    completedAt: number | null
  ): boolean => {
    const body: AgentJournalItemBody | null = completedAt
      ? zcodeStreamBody(state, text, { state: 'completed', completedAt })
      : zcodeStreamBody(state, text, { state: 'running' })
    if (!body) {
      return true
    }
    const options = {
      turnScope: deps.turnScopeFor(state.turnId),
      ...(state.startedAt !== undefined ? { observedAt: state.startedAt } : {})
    }
    const admission = deps.sink.tryAppendItem
      ? deps.sink.tryAppendItem(state.identity, body, options)
      : (deps.sink.appendItem(state.identity, body, options), { accepted: true as const })
    if (!admission.accepted) {
      return false
    }
    return deps.sink.tryPublish ? deps.sink.tryPublish({}).accepted : true
  }

  const coalescer = createAgentSessionDeltaCoalescer({
    maxRetainedBytes: ZCODE_STREAM_MAX_RETAINED_BYTES,
    maxTotalRetainedBytes: ZCODE_STREAM_TOTAL_MAX_BYTES,
    maxStreams: ZCODE_STREAM_MAX_STREAMS,
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    emit: (key, text) => {
      const state = states.get(key)
      if (!state) {
        return true
      }
      // Skip a checkpoint that adds too little to be worth a row rewrite.
      const nextLength = Math.max(state.checkpoint + 32, Math.ceil(state.checkpoint * 1.125))
      if (state.checkpoint > 0 && text.length < nextLength) {
        return true
      }
      if (!appendRow(state, text, null)) {
        return false
      }
      state.checkpoint = text.length
      return true
    }
  })

  return {
    handleDelta: ({ messageId, kind, delta, turnId, timestamp }) => {
      const reasoning = kind === 'reasoning_delta'
      if (kind !== 'text_delta' && !reasoning) {
        return { accepted: true }
      }
      const key = `${messageId}${STREAM_KEY_SEPARATOR}${reasoning ? 'reasoning' : 'text'}`
      let state = states.get(key)
      if (!state) {
        state = {
          identity: deps.identityFor(reasoning ? `${messageId}:reasoning` : messageId),
          reasoning,
          turnId,
          startedAt: timestamp,
          checkpoint: 0
        }
        states.set(key, state)
      }
      if (!coalescer.append(key, delta)) {
        return { accepted: false, reason: 'backpressure' }
      }
      return { accepted: true }
    },
    endTurn: (completedAt) => {
      coalescer.flushAll()
      for (const [key, state] of states) {
        const snapshot = coalescer.snapshot(key)
        // The completed rewrite carries the full text, bypassing the checkpoint
        // throttle; on sink refusal the stream stays for the timer's retry.
        if (snapshot && !appendRow(state, snapshot.text, completedAt)) {
          continue
        }
        coalescer.forget(key)
        states.delete(key)
      }
    },
    endTurnUnproven: () => {
      // Keep the running rows' last text visible, but never claim a completion
      // nobody saw: the journal's Stop rule decides what happens to the turn.
      coalescer.flushAll()
      coalescer.dispose()
      states.clear()
    },
    forget: (messageId) => {
      for (const channel of ['text', 'reasoning']) {
        const key = `${messageId}${STREAM_KEY_SEPARATOR}${channel}`
        coalescer.forget(key)
        states.delete(key)
      }
    },
    dispose: () => {
      coalescer.dispose()
      states.clear()
    }
  }
}

/** The journal row for a stream snapshot; null for blank text, which journals no row. */
function zcodeStreamBody(
  state: ZcodeStreamState,
  text: string,
  lifecycle: { state: 'running' | 'completed'; completedAt?: number }
): AgentJournalItemBody | null {
  if (state.reasoning) {
    return journalReasoningBody(text, lifecycle)
  }
  return {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }],
    ...lifecycle
  }
}
