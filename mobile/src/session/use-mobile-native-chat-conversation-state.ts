import { useCallback, useState } from 'react'

export type MobileNativeChatConversation = { surfaceId: string; sessionId: string | null }

// Reset conversation state on tab/session replacement, but not when its first session id arrives.
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
