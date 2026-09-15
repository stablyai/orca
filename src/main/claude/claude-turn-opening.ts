// Whether Orca's own send echo opens a turn.
//
// The provider's own output opens one too — see `ensureTurnOpen` in the
// translator, which the content sites call as they journal. Orca's turn used to
// open only here, while any `result` frame closed it, and that asymmetry is what
// leaves a working session reading idle: the provider resumes on its own when a
// background task reports in and wakes the agent, and nothing Orca sent ever
// arrives to reopen a turn.

import {
  claudeHasReplayContent,
  claudeRecord,
  claudeText,
  type ClaudeMessageEnvelope
} from './claude-structured-item-translation'
import {
  claudeProviderResumedTurnTimingAnchor,
  type ClaudeCurrentTurn
} from './claude-turn-lifecycle-item'

export type ClaudeSendEchoTurnInput = {
  envelope: ClaudeMessageEnvelope
  /** The raw frame: an absent `parent_tool_use_id` is not the same claim as an
   *  explicit `null`, and only a root frame carries a root turn. */
  frame: Record<string, unknown>
  /** Orca dispatched this send and the provider is replaying it back. */
  startsTurn: boolean
  observedAt: number
  /** Provider key of the user row this turn is anchored to. */
  userItemId: string
}

/** The turn a replayed send echo opens, or null when this frame is not one. */
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
        userItemId: input.userItemId
      }
    : null
}

/** Whether a frame is the root turn's own, rather than a child's. An absent
 *  `parent_tool_use_id` is a root frame: only a string names a parent, and a
 *  build that omits the field on root frames must not silently stop opening
 *  turns. */
export function isRootClaudeFrame(frame: Record<string, unknown>): boolean {
  return typeof frame.parent_tool_use_id !== 'string'
}

export type ClaudeTurnSource = { sessionId: string; uuid: string; assistant: boolean }

/** Reads a turn source off a raw frame, for the streamed path that has no envelope. */
export function claudeStreamTurnSource(frame: Record<string, unknown>): ClaudeTurnSource | null {
  const sessionId = claudeText(frame.session_id)
  const uuid = claudeText(frame.uuid)
  // A streamed delta only ever carries model output.
  return sessionId && uuid ? { sessionId, uuid, assistant: true } : null
}

/** A streamed assistant message has begun, before its first content delta. */
export function claudeStreamTurnStartSource(
  frame: Record<string, unknown>
): ClaudeTurnSource | null {
  const event = claudeRecord(frame.event)
  return frame.type === 'stream_event' && event?.type === 'message_start'
    ? claudeStreamTurnSource(frame)
    : null
}

/** The provider produced, so a turn is running. Root-ness first, then the
 *  suppression latch, then idempotency — every frame of one reply stays inside
 *  the turn its first frame opened. */
export function createClaudeTurnOpener(deps: {
  isTurnOpen: () => boolean
  isSuppressed: () => boolean
  open: (turn: ClaudeCurrentTurn, observedAt: number) => void
}): (frame: Record<string, unknown>, source: ClaudeTurnSource | null, observedAt: number) => void {
  return (frame, source, observedAt) => {
    if (!source?.assistant || !isRootClaudeFrame(frame)) {
      return
    }
    if (deps.isSuppressed() || deps.isTurnOpen()) {
      return
    }
    deps.open(
      {
        sessionId: source.sessionId,
        turnId: source.uuid,
        startedAt: observedAt,
        userItemId: claudeProviderResumedTurnTimingAnchor(source.sessionId, source.uuid)
      },
      observedAt
    )
  }
}
