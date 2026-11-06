import { useLayoutEffect, useMemo } from 'react'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { isPreviousMessageStop } from './mobile-native-chat-previous-message'

type TailStops = {
  previousStopsRef: { current: readonly string[] }
  refreshPreviousMessage: () => void
}

type Turns = {
  listMessages: readonly NativeChatMessage[]
  resolveRow: (
    index: number,
    message: NativeChatMessage
  ) => { joinsWorkRun?: boolean; foldedAway?: boolean }
}

/** User and assistant rows the previous-message button can land on, refreshed when scale or rows change. */
export function useMobileNativeChatPreviousStops(
  tail: TailStops,
  turns: Turns,
  keyOf: (message: NativeChatMessage) => string,
  layoutKey: string
): void {
  const previousStops = useMemo(
    () =>
      turns.listMessages.flatMap((message, index) =>
        isPreviousMessageStop(message.role, turns.resolveRow(index, message))
          ? [keyOf(message)]
          : []
      ),
    [keyOf, turns.listMessages, turns.resolveRow]
  )
  tail.previousStopsRef.current = previousStops
  useLayoutEffect(() => {
    tail.refreshPreviousMessage()
  }, [layoutKey, previousStops, tail.refreshPreviousMessage])
}
