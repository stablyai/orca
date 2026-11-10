import { useMemo } from 'react'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../src/shared/native-chat/transcript/native-chat-turn-status'
import { nativeChatGeneratedImageAnswers } from '../../../../../src/shared/native-chat/transcript/native-chat-generated-image-answers'
import { mobileNativeChatMarkdownImageSources } from './mobile-native-chat-markdown-image-sources'

export function useMobileNativeChatGeneratedImageAnswers(
  enabled: boolean,
  messages: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
): readonly NativeChatMessage[] {
  return useMemo(
    () =>
      enabled
        ? nativeChatGeneratedImageAnswers(
            messages,
            turnKeys,
            new Set(
              Object.entries(completedByTurn).flatMap(([key, status]) =>
                status.workedSeconds != null ? [key] : []
              )
            ),
            mobileNativeChatMarkdownImageSources
          )
        : messages,
    [enabled, messages, turnKeys, completedByTurn]
  )
}
