import { useCallback, useState } from 'react'

/** The conversation on screen: its tab, and the agent session the tab holds. */
export type MobileNativeChatConversation = { surfaceId: string; sessionId: string | null }

/** State that belongs to the conversation it was set in. A notification switching tabs, or the
 *  tab's agent session being replaced, clears it; the tab's first session id arriving does not. */
export function useMobileNativeChatConversationState<T>({
  surfaceId,
  sessionId
}: MobileNativeChatConversation): [T | null, (value: T | null) => void] {
  const [held, setHeld] = useState<{ value: T; owner: MobileNativeChatConversation } | null>(null)
  if (held) {
    const { owner } = held
    if (
      owner.surfaceId !== surfaceId ||
      (owner.sessionId !== null && owner.sessionId !== sessionId)
    ) {
      setHeld(null)
    } else if (owner.sessionId === null && sessionId !== null) {
      setHeld({ value: held.value, owner: { surfaceId, sessionId } })
    }
  }
  const set = useCallback(
    (value: T | null) =>
      setHeld(value === null ? null : { value, owner: { surfaceId, sessionId } }),
    [surfaceId, sessionId]
  )
  return [held?.value ?? null, set]
}
