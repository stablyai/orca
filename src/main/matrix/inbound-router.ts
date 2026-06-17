import { getMatrixService } from './matrix-service'
import { parseInboundHandle, stripReplyFallback } from './matrix-event-format'
import { paneKeyForHandle } from './session-handle-registry'
import { paneKeyForOutboundEvent } from './outbound-message-session-registry'
import { hasPendingAsk, resolveAsk } from './operator-ask-registry'
import type { InboundMatrixMessage } from './types'

// Routes inbound Matrix room messages to the addressed Orca agent session. The
// room is shared across sessions, so a message targets one in two ways: by
// REPLYING (m.in_reply_to) to one of the relay's messages — which routes back to
// that message's session without any typed handle — or, failing that, by a
// leading `@<handle>` token (the handle Orca minted for that session, see
// session-handle-registry). Unaddressed chatter is ignored; an addressed but
// unknown/closed session replies loudly into the room (in-band, per project
// doctrine) so the sender isn't left guessing.

// Structural slice of OrcaRuntimeService — keeps this module free of the heavy
// runtime types and trivially testable. OrcaRuntimeService satisfies it.
export type RuntimeDelivery = {
  getAgentStatusTerminalHandleForPaneKey(paneKey: string): string | undefined
  sendTerminal(handle: string, action: { text?: string; enter?: boolean }): Promise<unknown>
}

// Subscribes to inbound Matrix messages and delivers them. Returns an
// unsubscribe function (wired at app startup once the runtime exists).
export function startMatrixInboundRouter(runtime: RuntimeDelivery): () => void {
  return getMatrixService().onInbound((message) => {
    void routeInbound(runtime, message)
  })
}

// Resolved routing target. `paneKey` is null when an @handle resolved to no
// session (the loud "not a known" path); `handle` is set only on the @handle path
// so that reply can name it. A reply-relation target always has a real pane key.
type RouteTarget = { paneKey: string | null; text: string; handle: string | null }

// Reply-relation takes precedence over @handle: a reply to one of the relay's
// messages routes to THAT session, stripping the rich-reply quote fallback to
// recover what the operator typed. A reply to an unknown/evicted event (paneKey
// null) falls through to @handle parsing, as does a non-reply message.
function resolveRoute(message: InboundMatrixMessage): RouteTarget | null {
  if (message.inReplyToEventId) {
    const paneKey = paneKeyForOutboundEvent(message.inReplyToEventId)
    if (paneKey) {
      return { paneKey, text: stripReplyFallback(message.body), handle: null }
    }
  }
  const { handle, rest } = parseInboundHandle(message.body)
  if (!handle) {
    return null
  }
  return { paneKey: paneKeyForHandle(handle), text: rest, handle }
}

export async function routeInbound(
  runtime: RuntimeDelivery,
  message: InboundMatrixMessage
): Promise<void> {
  const target = resolveRoute(message)
  if (!target) {
    return
  }
  const { handle, text } = target
  // Only the @handle path can name a handle that maps to no session; the reply
  // path always resolved a real pane key, so only the former replies loudly here.
  if (target.paneKey === null) {
    // Why not lead with `@${handle}`: a reply starting with the handle token would
    // re-trigger the inbound parser, risking an error-message loop between relays.
    await replyLoud(message, `Handle "${handle}" is not a known Orca session.`)
    return
  }
  const paneKey = target.paneKey
  // Ask precedence: if the session's agent is blocked in orca_ask_operator, the
  // reply is the answer to that question — route it to the waiter, not the
  // terminal (the agent isn't reading the terminal while it blocks). An empty
  // reply is ignored so the ask keeps waiting for a real answer.
  if (hasPendingAsk(paneKey)) {
    const answer = text.trim()
    if (!answer) {
      return
    }
    resolveAsk(paneKey, answer)
    ackReceived(message)
    return
  }
  const terminalHandle = runtime.getAgentStatusTerminalHandleForPaneKey(paneKey)
  if (!terminalHandle) {
    // Loud for both paths: a reply to a session that has since closed must not be
    // swallowed (the operator typed something and deserves to know it went nowhere).
    const who = handle ? `Handle "${handle}"` : 'That session'
    await replyLoud(message, `${who} is no longer an active Orca session.`)
    return
  }
  if (!text.trim()) {
    return
  }
  try {
    await runtime.sendTerminal(terminalHandle, { text, enter: true })
    // Acknowledge receipt so the operator can see their message was delivered to
    // the session — otherwise inbound delivery is silent and they can't tell it
    // landed (encrypted-room replies show no other feedback).
    ackReceived(message)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const who = handle ? `@${handle}` : 'the session'
    await replyLoud(message, `Failed to deliver to ${who}: ${detail}`)
  }
}

// Emoji reaction posted on the operator's message to confirm Orca received and
// delivered it to the session. Reactions are unencrypted annotations, so they
// show up regardless of the room's E2E state.
const RECEIVED_REACTION = '✅'

function ackReceived(message: InboundMatrixMessage): void {
  // Fire-and-forget but loud on failure: a missing ack must not block routing,
  // but a swallowed failure would hide that confirmations aren't reaching the room.
  void getMatrixService()
    .sendReaction(message.eventId, RECEIVED_REACTION)
    .then((result) => {
      if (!result.ok) {
        console.warn(`[matrix] receipt reaction failed: ${result.error}`)
      }
    })
    .catch((error) => {
      console.warn(`[matrix] receipt reaction threw: ${String(error)}`)
    })
}

async function replyLoud(message: InboundMatrixMessage, body: string): Promise<void> {
  await getMatrixService().sendToRoom(body, { inReplyTo: message.eventId })
}
