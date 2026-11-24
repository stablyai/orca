import { useMemo } from 'react'
import { nativeChatReasoningDisclosureKey } from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-reasoning-row'
import {
  nativeChatLiveLine,
  type NativeChatLiveLine
} from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-live-line'

export type MobileNativeChatLiveLine = NativeChatLiveLine & { reasoningExpanded: boolean }

export function useMobileNativeChatLiveLine({
  draws,
  thinking,
  stopping,
  activityText,
  messages,
  inLiveWorkingTurn,
  expandedReasoning
}: Parameters<typeof nativeChatLiveLine>[0] & {
  expandedReasoning: ReadonlySet<string>
}): MobileNativeChatLiveLine | null {
  const line = useMemo(
    () =>
      nativeChatLiveLine({ draws, thinking, stopping, activityText, messages, inLiveWorkingTurn }),
    [draws, thinking, stopping, activityText, messages, inLiveWorkingTurn]
  )
  return useMemo(
    () =>
      line && {
        ...line,
        reasoningExpanded:
          line.reasoning !== null &&
          expandedReasoning.has(nativeChatReasoningDisclosureKey(line.reasoning.message.id))
      },
    [expandedReasoning, line]
  )
}
