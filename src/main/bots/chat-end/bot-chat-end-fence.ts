// While a bot chat is being ended, nothing new may be accepted for it: mail, Dispatch custody, Run
// binding, thread links, automation targets or turns are refused with no effect until the end
// commits (then the durable ended mark refuses them) or is kept (then they flow again).
import { refuseUnclassified } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'

const fenced = new Set<string>()
/** Ends whose write outcome is unknown: fenced until a restart reloads a consistent store. */
const unresolved = new Set<string>()

export const CHAT_BEING_ENDED = 'This chat is being ended. Try again in a moment.'
export const CHAT_ENDED = 'This chat was ended. Reopen it to continue.'

export function fenceChatEnd(sessionIds: readonly string[]): void {
  sessionIds.forEach((id) => fenced.add(id))
}

/** Lifts the fence; an end whose outcome is unknown keeps it until restart. */
export function liftChatEndFence(sessionIds: readonly string[]): void {
  sessionIds.forEach((id) => {
    if (!unresolved.has(id)) {
      fenced.delete(id)
    }
  })
}

export function holdChatEndUntilRestart(sessionIds: readonly string[]): void {
  sessionIds.forEach((id) => {
    unresolved.add(id)
    fenced.add(id)
  })
}

export function anyChatEndFenced(): boolean {
  return fenced.size > 0
}

export function isChatEndFenced(sessionId: string): boolean {
  return fenced.size > 0 && fenced.has(sessionId)
}

export function isChatEndUnresolved(sessionId: string): boolean {
  return unresolved.size > 0 && unresolved.has(sessionId)
}

/** Durably ended, or being ended now. */
export function chatClosedToNewWork(sessionId: string): boolean {
  return (
    isChatEndFenced(sessionId) ||
    getStructuredAgentSessionHost()?.deps.store.isSessionEnded(sessionId) === true
  )
}

/** The turn gate: refuse a turn into a chat being ended (retry) or ended (reopen first). */
export function botChatTurnRefusal(sessionId: string): AgentSessionWireRefusal | null {
  if (isChatEndFenced(sessionId)) {
    return refuseUnclassified('agent_session_conflict', CHAT_BEING_ENDED)
  }
  return getStructuredAgentSessionHost()?.deps.store.isSessionEnded(sessionId) === true
    ? refuseUnclassified('agent_session_operation_invalid', CHAT_ENDED)
    : null
}

export function resetChatEndFencesForTests(): void {
  fenced.clear()
  unresolved.clear()
}
