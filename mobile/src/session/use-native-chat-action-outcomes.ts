import { useCallback } from 'react'

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
