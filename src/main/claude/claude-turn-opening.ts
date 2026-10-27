import {
  claudeHasReplayContent,
  claudeRecord,
  claudeText,
  type ClaudeMessageEnvelope
} from './claude-structured-item-translation'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import type { ClaudeStartedSend } from './claude-structured-session-state'
import {
  claudeProviderResumedTurnTimingAnchor,
  type ClaudeCurrentTurn
} from './claude-turn-lifecycle-item'

export type ClaudeSendEchoTurnInput = {
  envelope: ClaudeMessageEnvelope
  /** Send echoes require explicit null parent_tool_use_id; an omitted field is insufficient. */
  frame: Record<string, unknown>
  startsTurn: boolean
  observedAt: number
  /** Host submission time, when known. */
  requestedAt?: number
  userItemId: string
}

export function claudeTurnOpenedBySendEcho(
  input: ClaudeSendEchoTurnInput
): ClaudeCurrentTurn | null {
  const { envelope } = input
  return envelope.role === 'user' &&
    input.startsTurn &&
    claudeHasReplayContent(envelope) &&
    input.frame.parent_tool_use_id === null
    ? {
        sessionId: envelope.sessionId,
        turnId: envelope.uuid,
        startedAt: input.observedAt,
        ...(input.requestedAt === undefined ? {} : { requestedAt: input.requestedAt }),
        userItemId: input.userItemId
      }
    : null
}

/** Omitted parent fields still count as root output for compatibility with older builds. */
export function isRootClaudeFrame(frame: Record<string, unknown>): boolean {
  return typeof frame.parent_tool_use_id !== 'string'
}

/** Empty parent strings cannot identify a producer, even though isRootClaudeFrame treats them as children. */
export function claudeFrameParentRef(frame: Record<string, unknown>): string | null {
  return typeof frame.parent_tool_use_id === 'string' && frame.parent_tool_use_id.length > 0
    ? frame.parent_tool_use_id
    : null
}

export type ClaudeTurnSource = { sessionId: string; uuid: string; assistant: boolean }

export function claudeStreamTurnSource(frame: Record<string, unknown>): ClaudeTurnSource | null {
  const sessionId = claudeText(frame.session_id)
  const uuid = claudeText(frame.uuid)
  return sessionId && uuid ? { sessionId, uuid, assistant: true } : null
}

export function claudeStreamTurnStartSource(
  frame: Record<string, unknown>
): ClaudeTurnSource | null {
  const event = claudeRecord(frame.event)
  return frame.type === 'stream_event' && event?.type === 'message_start'
    ? claudeStreamTurnSource(frame)
    : null
}

/** Root output opens once; a started send lifts suppression, otherwise the provider resumed on its own. */
export function createClaudeTurnOpener(deps: {
  isTurnOpen: () => boolean
  isSuppressed: () => boolean
  startedSend: () => ClaudeStartedSend | null
  open: (turn: ClaudeCurrentTurn, observedAt: number) => void
}): (frame: Record<string, unknown>, source: ClaudeTurnSource | null, observedAt: number) => void {
  return (frame, source, observedAt) => {
    if (!source?.assistant || !isRootClaudeFrame(frame)) {
      return
    }
    const send = deps.startedSend()
    if ((!send && deps.isSuppressed()) || deps.isTurnOpen()) {
      return
    }
    deps.open(
      {
        sessionId: source.sessionId,
        turnId: source.uuid,
        startedAt: observedAt,
        ...(send?.requestedAt === undefined ? {} : { requestedAt: send.requestedAt }),
        userItemId: send
          ? agentJournalSubmissionKey(send.clientMessageId)
          : claudeProviderResumedTurnTimingAnchor(source.sessionId, source.uuid)
      },
      observedAt
    )
  }
}
