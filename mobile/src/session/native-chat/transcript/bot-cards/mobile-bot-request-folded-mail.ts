// Mail a bot-request card already shows (its answer, or Orca's word that none came): the chat folds
// the "Message from" card for it into the request card, as the desktop does.
import { useSyncExternalStore } from 'react'
import type { AgentMessageSource } from '../../../../../../src/shared/agent-session/journal/agent-session-message-source'
import { mailNoticeMessageIds } from '../../../../../../src/shared/bots/bot-request-card-view'

const folded = new Set<string>()
const listeners = new Set<() => void>()

export function foldMobileBotRequestMail(ids: readonly string[]): void {
  const fresh = ids.filter((id) => !folded.has(id))
  if (fresh.length === 0) {
    return
  }
  for (const id of fresh) {
    folded.add(id)
  }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether every message a mail card points at is shown on a request card. */
export function useMobileFoldedIntoBotRequest(from: AgentMessageSource | undefined): boolean {
  const mail = mailNoticeMessageIds(from)
  // The row's own answer is the snapshot, so a fold elsewhere re-renders no other row.
  return useSyncExternalStore(
    subscribe,
    () => mail.length > 0 && mail.every((messageId) => folded.has(messageId)),
    () => false
  )
}
