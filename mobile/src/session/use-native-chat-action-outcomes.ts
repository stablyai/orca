import { useCallback } from 'react'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'

/** Wraps a chat card action so an accepted write also retires the route's held
 *  failure banner.
 *
 *  The banner outlives the write that raised it, so every accepted action has to
 *  retire it — not just the composer send, which was the only one that did. A
 *  delivered answer or permission reply otherwise sits under a stale "not sent"
 *  until the hold timer happens to expire. */
export function useNativeChatAcceptedAction<Params extends unknown[]>(
  action: (...params: Params) => Promise<boolean>,
  onAccepted: () => void
): (...params: Params) => Promise<boolean> {
  return useCallback(
    async (...params: Params): Promise<boolean> => {
      const accepted = await action(...params)
      if (accepted) {
        onAccepted()
      }
      return accepted
    },
    [action, onAccepted]
  )
}

/** Boolean surface for callers with no pre-pasted input: 'unknown' stays true
 *  (the send usually landed; the optimistic echo is already held unconfirmed). */
export function useNativeChatSentFlag(
  send: (text: string, images?: string[]) => Promise<MobileNativeChatSendOutcome>
): (text: string, images?: string[]) => Promise<boolean> {
  return useCallback(
    async (text: string, images?: string[]): Promise<boolean> =>
      (await send(text, images)) !== 'rejected',
    [send]
  )
}
