import { useCallback } from 'react'

// Any accepted card action must retire the route’s held failure banner, which otherwise outlives its failed write.
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
