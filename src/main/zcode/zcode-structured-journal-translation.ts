// Turns ZCode app-server events into journal rows.
//
// ZCode's protocol is session-scoped, so item identities use the `legacy` arm
// keyed by the provider's own message and part ids. Journal-first: a frame's
// rows land in the journal before the event publishes to the host, so a crash
// can only ever lose the host's view, never a row the user saw.
// Payload field readers: zcode-structured-journal-payload-readers.ts.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalTurnOutcome,
  type AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../shared/agent-session-turn-record'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  appendZcodeItemAndPublish,
  zcodeItemIdentity,
  zcodeMessageIdentity,
  zcodeToolIdentity,
  zcodeTurnIdentity
} from './zcode-structured-journal-sink'
import {
  readZcodeMessageParts,
  readZcodeModelStreamingEvent,
  type ZcodeSessionEvent
} from './zcode-protocol-events'
import { createZcodeStreamTranslator } from './zcode-structured-stream-translation'
import {
  agentKey,
  readRecord,
  readString,
  zcodeToolOutput,
  zcodeToolState
} from './zcode-structured-journal-payload-readers'

export type ZcodeJournalTranslationAdmission =
  | { accepted: true }
  | { accepted: false; reason: 'backpressure' | 'failed' | 'closed' | 'untranslated' }

export const ZCODE_JOURNAL_ADMITTED: ZcodeJournalTranslationAdmission = { accepted: true }

export type ZcodeJournalTranslator = {
  handle: (event: ZcodeSessionEvent) => ZcodeJournalTranslationAdmission
  /** Seeds the journal from a `session/create`/`session/resume` snapshot, before publication. */
  restoreSnapshot: (messages: unknown[]) => ZcodeJournalTranslationAdmission
  /**
   * Writes the durable pending-approval row a reverse-RPC prompt waits on. The live
   * prompt is the claim state, but a second client answers from the journal, so the
   * row has to exist even when the asker never polls it.
   */
  announcePrompt: (prompt: {
    itemId: string
    toolName: string
    detail: string | null
    options: { id: string; label: string }[]
  }) => ZcodeJournalTranslationAdmission
  endTurnUnproven: (turnId: string | undefined) => void
  dispose: () => void
}

export type ZcodeJournalTranslatorDeps = {
  sessionId: string
  sink: StructuredAgentSessionEventSink
  now: () => number
  /** Injected by tests so the delta window can be driven without real time. */
  schedule?: (run: () => void, ms: number) => () => void
}

function turnIdentity(turnId: string): AgentJournalItemIdentity {
  return zcodeTurnIdentity(turnId)
}

function messageIdentity(messageId: string): AgentJournalItemIdentity {
  return zcodeMessageIdentity(messageId)
}

/** ZCode's turn result vocabulary, or null when this host cannot place one. */
export function zcodeTurnOutcome(
  resultType: string | null | undefined
): AgentJournalTurnOutcome | null {
  if (resultType === 'success') {
    return 'success'
  }
  if (resultType === 'cancelled') {
    return 'cancellation'
  }
  return resultType && resultType.startsWith('error') ? 'failure' : null
}

/**
 * Builds the journal translator for one child. `handle` consumes live events;
 * `restoreSnapshot` seeds history before the acquisition publishes.
 */
export function createZcodeJournalTranslator(
  deps: ZcodeJournalTranslatorDeps
): ZcodeJournalTranslator {
  const { sink, sessionId } = deps
  /** The turn record each message belongs to, by the ZCode turn id on the event. */
  let currentTurn: { turnId: string; userItemId: string | null; startedAt: number } | null = null
  let disposed = false

  const turnScopeFor = (turnId: string | undefined): AgentJournalTurnScope =>
    turnId && currentTurn?.turnId === turnId
      ? { kind: 'turn', turnItemId: agentKey(turnIdentity(turnId)) }
      : AGENT_JOURNAL_THREAD_SCOPE

  // This build's assistant text arrives only as `model.streaming` deltas; whole
  // `message.upserted` frames never come for assistant messages.
  const streams = createZcodeStreamTranslator({
    sink,
    identityFor: messageIdentity,
    turnScopeFor,
    ...(deps.schedule ? { schedule: deps.schedule } : {})
  })

  const handleTurnStarted = (event: ZcodeSessionEvent): ZcodeJournalTranslationAdmission => {
    const turnId = readString(event.payload, 'turnId') ?? `turn-${event.seq}`
    const startedAt = event.timestamp
    currentTurn = { turnId, userItemId: null, startedAt }
    return appendZcodeItemAndPublish(
      sink,
      turnIdentity(turnId),
      agentJournalTurnBody({ turnId, state: 'running', startedAt }),
      AGENT_JOURNAL_THREAD_SCOPE,
      { lifecycle: true, observedAt: startedAt, coalescingKey: `turn-start:${sessionId}:${turnId}` }
    )
  }

  const handleTurnCompleted = (event: ZcodeSessionEvent): ZcodeJournalTranslationAdmission => {
    const turnId = readString(event.payload, 'turnId') ?? currentTurn?.turnId
    if (!turnId) {
      return ZCODE_JOURNAL_ADMITTED
    }
    const resultType = readString(event.payload, 'resultType')
    const wasCurrent = currentTurn?.turnId === turnId
    const outcome = zcodeTurnOutcome(resultType)
    const turn = wasCurrent ? currentTurn : null
    // Lifecycle bypasses the delta window: the completed assistant row lands in
    // the journal before the turn row names the turn ended.
    streams.endTurn(event.timestamp)
    const admission = appendZcodeItemAndPublish(
      sink,
      turnIdentity(turnId),
      agentJournalTurnBody({
        turnId,
        state: resultType === 'cancelled' ? 'interrupted' : 'completed',
        ...(outcome ? { outcome } : {}),
        ...(turn?.userItemId ? { userItemId: turn.userItemId } : {}),
        ...(turn ? { startedAt: turn.startedAt } : {}),
        completedAt: event.timestamp
      }),
      AGENT_JOURNAL_THREAD_SCOPE,
      { lifecycle: true }
    )
    if (wasCurrent) {
      currentTurn = null
    }
    return admission
  }

  /** One whole ZCode message → its journal message row, `null` for unnameable or blank ones. */
  const messageRowFrom = (
    message: unknown,
    timestamp: number | null
  ): {
    messageId: string
    identity: AgentJournalItemIdentity
    body: AgentJournalItemBody
  } | null => {
    // Some builds file the id inside `info` rather than at the top level; skipping
    // those would silently drop the message from a resumed chat.
    const messageId =
      readString(message, 'messageId') ?? readString(readRecord(message, 'info') ?? {}, 'messageId')
    const role = readString(readRecord(message, 'info') ?? message, 'role') ?? 'assistant'
    const blocks = readZcodeMessageParts(message)
    if (!messageId || blocks.length === 0) {
      return null
    }
    const isUser = role === 'user'
    if (isUser && currentTurn && !currentTurn.userItemId) {
      currentTurn.userItemId = agentKey(messageIdentity(messageId))
    }
    return {
      messageId,
      identity: messageIdentity(messageId),
      body: {
        kind: 'message',
        role: isUser ? 'user' : 'assistant',
        blocks,
        state: 'completed',
        ...(timestamp === null ? {} : { completedAt: timestamp })
      }
    }
  }

  const handleMessageUpserted = (event: ZcodeSessionEvent): ZcodeJournalTranslationAdmission => {
    const row = messageRowFrom(
      readRecord(event.payload, 'message') ?? event.payload,
      event.timestamp
    )
    if (!row) {
      return ZCODE_JOURNAL_ADMITTED
    }
    // A whole-message upsert is authoritative: its accumulated stream copy is stale.
    streams.forget(row.messageId)
    return appendZcodeItemAndPublish(
      sink,
      row.identity,
      row.body,
      turnScopeFor(readString(event, 'turnId') ?? undefined)
    )
  }

  const handleToolPart = (event: ZcodeSessionEvent): ZcodeJournalTranslationAdmission => {
    const part = readRecord(event.payload, 'part') ?? event.payload
    const messageId = readString(part, 'messageId') ?? readString(event.payload, 'messageId')
    const partId = readString(part, 'partId')
    if (!messageId || !partId || readString(part, 'type') !== 'tool') {
      return ZCODE_JOURNAL_ADMITTED
    }
    const state = readRecord(part, 'state') ?? {}
    const bodyState = zcodeToolState(readString(state, 'status') ?? readString(part, 'state'))
    const body: AgentJournalItemBody = {
      kind: 'tool-call',
      name: readString(part, 'tool') ?? 'tool',
      input: state.input ?? null,
      ...(readString(part, 'callId') ? { callId: readString(part, 'callId') } : {}),
      state: bodyState,
      ...(bodyState === 'running' ? {} : { output: zcodeToolOutput(state) })
    }
    return appendZcodeItemAndPublish(
      sink,
      zcodeToolIdentity(messageId, partId),
      body,
      turnScopeFor(readString(event, 'turnId') ?? undefined)
    )
  }

  const handleSessionEvent = (event: ZcodeSessionEvent): ZcodeJournalTranslationAdmission => {
    if (disposed) {
      return { accepted: false, reason: 'closed' }
    }
    switch (event.type) {
      case 'turn.started':
        return handleTurnStarted(event)
      case 'turn.completed':
        return handleTurnCompleted(event)
      case 'message.upserted':
        return handleMessageUpserted(event)
      case 'model.streaming': {
        const streaming = readZcodeModelStreamingEvent(event.payload)
        if (!streaming || streaming.done) {
          // A final empty delta carries no text; the turn end closes the row.
          return ZCODE_JOURNAL_ADMITTED
        }
        const admission = streams.handleDelta({
          messageId: streaming.messageId,
          kind: streaming.kind,
          delta: streaming.delta,
          turnId: readString(event, 'turnId') ?? undefined,
          timestamp: event.timestamp
        })
        return admission.accepted ? ZCODE_JOURNAL_ADMITTED : admission
      }
      case 'part.delta':
        // Deltas stream inside a message ZCode also upserts; the upsert carries
        // the full text, so a delta only refreshes activity, not a body.
        return ZCODE_JOURNAL_ADMITTED
      case 'part.started':
      case 'part.upserted':
        return handleToolPart(event)
      default:
        return ZCODE_JOURNAL_ADMITTED
    }
  }

  const restoreSnapshot = (messages: unknown[]): ZcodeJournalTranslationAdmission => {
    for (const raw of messages) {
      if (typeof raw !== 'object' || raw === null) {
        continue
      }
      const row = messageRowFrom(raw, null)
      if (!row) {
        continue
      }
      const admission = appendZcodeItemAndPublish(
        sink,
        row.identity,
        row.body,
        AGENT_JOURNAL_THREAD_SCOPE
      )
      if (!admission.accepted) {
        return admission
      }
    }
    return ZCODE_JOURNAL_ADMITTED
  }

  const announcePrompt = (prompt: {
    itemId: string
    toolName: string
    detail: string | null
    options: { id: string; label: string }[]
  }): ZcodeJournalTranslationAdmission => {
    return appendZcodeItemAndPublish(
      sink,
      zcodeItemIdentity(`prompt:${prompt.itemId}`),
      {
        kind: 'approval',
        title: `Allow ${prompt.toolName}?`,
        detail: prompt.detail,
        options: prompt.options,
        resolution: {
          state: 'pending',
          selectedOptionId: null,
          resolvedBy: null,
          resolvedAt: null
        }
      },
      turnScopeFor(currentTurn?.turnId)
    )
  }

  return {
    handle: handleSessionEvent,
    restoreSnapshot,
    announcePrompt,
    endTurnUnproven: (turnId) => {
      const id = turnId ?? currentTurn?.turnId
      if (!id) {
        return
      }
      // The turn is unverifiable, so the streams it left open keep their last
      // running snapshot rather than claiming a completion nobody saw.
      streams.endTurnUnproven()
      sink.appendItem(
        turnIdentity(id),
        agentJournalTurnBody({
          turnId: id,
          state: 'unverifiable',
          ...(currentTurn?.turnId === id ? { startedAt: currentTurn.startedAt } : {})
        }),
        { lifecycle: true, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      sink.publish({ lifecycle: true })
      if (currentTurn?.turnId === id) {
        currentTurn = null
      }
    },
    dispose: () => {
      disposed = true
      streams.dispose()
    }
  }
}
