import {
  rowsBesideStreamedText,
  streamedTextReplacementIndexes,
  noteStreamedTextRevision
} from '../../../../../../src/shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { useContext, useMemo } from 'react'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-status'
import {
  nativeChatGeneratedImageAnswers,
  reviseNativeChatGeneratedImageAnswer
} from '../../../../../../src/shared/native-chat/transcript/images/native-chat-generated-image-answers'
import { MobileNativeChatVisualContext } from '../../visual/mobile-native-chat-visual-context'
import {
  mobileNativeChatMarkdownImageSources,
  mobileNativeChatVisualMarkdownImageSources
} from './mobile-native-chat-markdown-image-sources'

export function useMobileNativeChatGeneratedImageAnswers(
  enabled: boolean,
  messages: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
): readonly NativeChatMessage[] {
  const visuals = useContext(MobileNativeChatVisualContext)
  const sources = visuals
    ? mobileNativeChatVisualMarkdownImageSources
    : mobileNativeChatMarkdownImageSources
  const base = rowsBesideStreamedText(messages)
  const projected = useMemo(
    () =>
      enabled
        ? nativeChatGeneratedImageAnswers(
            base,
            turnKeys,
            new Set(
              Object.entries(completedByTurn).flatMap(([key, status]) =>
                status.workedSeconds != null ? [key] : []
              )
            ),
            sources
          )
        : base,
    [enabled, base, turnKeys, completedByTurn, sources]
  )
  if (projected === base) {
    return messages
  }
  const indexes = streamedTextReplacementIndexes(base, messages) ?? []
  if (!indexes.length) {
    return projected
  }
  const next = projected.slice()
  for (const index of indexes) {
    next[index] = reviseNativeChatGeneratedImageAnswer(base[index]!, messages[index]!)
  }
  noteStreamedTextRevision(next, projected, indexes)
  return next
}
