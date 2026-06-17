import { getMatrixService } from './matrix-service'
import { formatHandlePrefix } from './matrix-event-format'
import { handleForPaneKey } from './session-handle-registry'
import { recordOutboundMessage } from './outbound-message-session-registry'

// Forwards Orca agent-status transitions into the shared Matrix room, tagged with
// the session handle. Opt-in: the master switch gates everything; the granular
// flags split routine status (working/waiting/done) from attention signals
// (blocked / interrupted), so a user can subscribe to "needs me" without the
// chatter. Dedupe per session means only state CHANGES are sent, not every tick.

export type MatrixForwardSettings = {
  matrixEnabled?: boolean
  matrixForwardSystemMessages?: boolean
  matrixForwardAgentStatus?: boolean
  matrixForwardErrors?: boolean
}

export type AgentStatusForwardEvent = {
  paneKey: string
  payload: {
    state: 'working' | 'blocked' | 'waiting' | 'done'
    agentType?: string
    toolName?: string
    // The agent's most recent assistant message — the same text the desktop
    // notification shows as its summary. Mirrored into the room on
    // completion/attention states so a forward isn't just a bare status line.
    lastAssistantMessage?: string
    interrupted?: boolean
  }
}

// A Matrix room message can hold far more than an OS toast (which caps at ~180),
// but an unbounded assistant message would flood the room — cap the mirrored
// summary at a generous-but-bounded length.
const SUMMARY_MAX_LENGTH = 1500

const lastForwardedState = new Map<string, string>()

// `blocked` (waiting on the user) and an interrupted end are the "needs
// attention" signals; everything else is routine status.
function isAttention(payload: AgentStatusForwardEvent['payload']): boolean {
  return payload.state === 'blocked' || payload.interrupted === true
}

// Trims surrounding whitespace and truncates with an ellipsis at a UTF-16-safe
// boundary (never split a surrogate pair). Newlines inside the message are kept
// — Matrix m.text renders them, unlike the single-line OS-toast preview.
function normalizeSummary(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (trimmed.length <= SUMMARY_MAX_LENGTH) {
    return trimmed
  }
  const truncated = trimmed.slice(0, SUMMARY_MAX_LENGTH - 1)
  const lastCode = truncated.charCodeAt(truncated.length - 1)
  const safe = lastCode >= 0xd800 && lastCode <= 0xdbff ? truncated.slice(0, -1) : truncated
  return `${safe}…`
}

function describeStatus(payload: AgentStatusForwardEvent['payload']): string {
  const agent = payload.agentType ? `${payload.agentType} ` : ''
  switch (payload.state) {
    case 'working':
      return `${agent}is working${payload.toolName ? ` (${payload.toolName})` : ''}`
    case 'waiting':
      return `${agent}is waiting`
    case 'blocked':
      return `${agent}needs input`
    case 'done':
      return payload.interrupted ? `${agent}was interrupted` : `${agent}finished`
  }
}

export function forwardAgentStatusToMatrix(
  settings: MatrixForwardSettings,
  event: AgentStatusForwardEvent
): void {
  // Matrix off → nothing to forward to: bail before any work (incl. the
  // registry read in handleForPaneKey) so a stale forward flag can't drive
  // sync I/O or a doomed send on the status-event hot path when Matrix is off.
  if (!settings.matrixEnabled) {
    return
  }
  if (!settings.matrixForwardSystemMessages) {
    return
  }
  const wanted = isAttention(event.payload)
    ? settings.matrixForwardErrors === true
    : settings.matrixForwardAgentStatus === true
  if (!wanted) {
    return
  }
  // Dedupe on the raw state so a session that stays "working" across many tool
  // calls only announces the transition once.
  if (lastForwardedState.get(event.paneKey) === event.payload.state) {
    return
  }
  lastForwardedState.set(event.paneKey, event.payload.state)

  const handle = handleForPaneKey(event.paneKey)
  const status = describeStatus(event.payload)
  // Mirror the notification's summary (the agent's last assistant message) below
  // the status line, but only when the agent has paused/finished — on `working`
  // the message is transient streaming/tool activity (toolName already conveys
  // it), so appending it would be noise rather than a summary.
  const summary =
    event.payload.state === 'working' ? '' : normalizeSummary(event.payload.lastAssistantMessage)
  const body = formatHandlePrefix(handle, summary ? `${status}\n${summary}` : status)
  // Fire-and-forget so a forward never blocks the status pipeline — but loud on
  // failure: swallowing the send result hides real breakage (a send failing, or
  // the client not running). Log it so it surfaces in the readable main-process
  // output instead of vanishing.
  void getMatrixService()
    .sendToRoom(body)
    .then((result) => {
      if (!result.ok) {
        console.warn(`[matrix] system-message forward failed: ${result.error}`)
        return
      }
      // Remember which session this status message belongs to so an operator
      // reply to it routes straight back to that session (no @handle needed).
      recordOutboundMessage(result.eventId, event.paneKey)
    })
    .catch((error) => {
      console.warn(`[matrix] system-message forward threw: ${String(error)}`)
    })
}

// Testing seam: clears the per-session dedupe memory.
export function resetForwarderStateForTests(): void {
  lastForwardedState.clear()
}
