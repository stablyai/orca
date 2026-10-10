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
import { readZcodeMessageParts, type ZcodeSessionEvent } from './zcode-protocol-events'
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
}

function identityFor(recordId: string): AgentJournalItemIdentity {
  // ZCode ids are session-scoped on the wire, so the session id rides the arm.
  return { provider: 'legacy', agent: 'zcode', sessionId: '', recordId }
}

function turnIdentity(turnId: string): AgentJournalItemIdentity {
  return identityFor(`turn-lifecycle:${turnId}`)
}

function messageIdentity(messageId: string): AgentJournalItemIdentity {
  return identityFor(`message:${messageId}`)
}

function toolIdentity(messageId: string, partId: string): AgentJournalItemIdentity {
  return identityFor(`tool:${messageId}:${partId}`)
} /** Appends one item and publishes it, honoring the sink's non-blocking variants. */
function appendAndPublish(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  turnScope: AgentJournalTurnScope,
  options: { lifecycle?: boolean; observedAt?: number; coalescingKey?: string } = {}
): ZcodeJournalTranslationAdmission {
  const admission = sink.tryAppendItem
    ? sink.tryAppendItem(identity, body, {
        turnScope,
        ...(options.lifecycle ? { lifecycle: true } : {}),
        ...(options.observedAt !== undefined ? { observedAt: options.observedAt } : {})
      })
    : (sink.appendItem(
        identity,
        body,
        options.observedAt !== undefined
          ? { turnScope, observedAt: options.observedAt }
          : { turnScope }
      ),
      ZCODE_JOURNAL_ADMITTED)
  if (!admission.accepted) {
    return admission
  }
  return sink.tryPublish
    ? sink.tryPublish({
        ...(options.lifecycle ? { lifecycle: true } : {}),
        ...(options.coalescingKey ? { coalescingKey: options.coalescingKey } : {})
      })
    : ZCODE_JOURNAL_ADMITTED
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

  const handleTurnStarted = (event: ZcodeSessionEvent): ZcodeJournalTranslationAdmission => {
    const turnId = readString(event.payload, 'turnId') ?? `turn-${event.seq}`
    const startedAt = event.timestamp
    currentTurn = { turnId, userItemId: null, startedAt }
    return appendAndPublish(
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
    const admission = appendAndPublish(
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

  const handleMessageUpserted = (event: ZcodeSessionEvent): ZcodeJournalTranslationAdmission => {
    const message = readRecord(event.payload, 'message') ?? event.payload
    // Some builds file the id inside `info` rather than at the top level; skipping
    // those would silently drop the message from a resumed chat.
    const messageId =
      readString(message, 'messageId') ?? readString(readRecord(message, 'info') ?? {}, 'messageId')
    if (!messageId) {
      return ZCODE_JOURNAL_ADMITTED
    }
    const role = readString(message.info ?? message, 'role') ?? 'assistant'
    const blocks = readZcodeMessageParts(message)
    const isUser = role === 'user'
    if (isUser && currentTurn && !currentTurn.userItemId) {
      currentTurn.userItemId = agentKey(messageIdentity(messageId))
    }
    return appendAndPublish(
      sink,
      messageIdentity(messageId),
      {
        kind: 'message',
        role: isUser ? 'user' : 'assistant',
        blocks,
        // ZCode upserts whole messages; a running state only survives until the
        // next upsert, and the turn end closes whatever is left open.
        state: 'completed',
        completedAt: event.timestamp
      },
      turnScopeFor(readString(event, 'turnId') ?? undefined)
    )
  }

  const handlePartDelta = (): ZcodeJournalTranslationAdmission => {
    // Deltas stream inside a message ZCode also upserts; the upsert carries the
    // full text, so a delta only updates the running row's activity, not a body.
    return ZCODE_JOURNAL_ADMITTED
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
    return appendAndPublish(
      sink,
      toolIdentity(messageId, partId),
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
      case 'part.delta':
        return handlePartDelta()
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
      const message = raw
      // Same `info.messageId` fallback as the live upsert path: snapshots from builds
      // that file the id inside `info` would otherwise lose their history.
      const messageId =
        readString(message, 'messageId') ??
        readString(readRecord(message, 'info') ?? {}, 'messageId')
      const role = readString(readRecord(message, 'info') ?? message, 'role') ?? 'assistant'
      const blocks = readZcodeMessageParts(message)
      if (!messageId || blocks.length === 0) {
        continue
      }
      const admission = appendAndPublish(
        sink,
        messageIdentity(messageId),
        {
          kind: 'message',
          role: role === 'user' ? 'user' : 'assistant',
          blocks,
          state: 'completed'
        },
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
    return appendAndPublish(
      sink,
      identityFor(`prompt:${prompt.itemId}`),
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
    }
  }
}
