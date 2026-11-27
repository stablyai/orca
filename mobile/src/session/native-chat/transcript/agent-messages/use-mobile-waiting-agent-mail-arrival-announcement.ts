import { useEffect, useRef } from 'react'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import {
  agentMessageHeading,
  agentMessagePrimarySender,
  agentMessageSavedName
} from '../../../../../../src/shared/agent-session/view/messages/agent-message-presentation'
import { agentMessagePreviewLine } from '../../../../../../src/shared/agent-session/view/messages/agent-message-preview-line'
import { useAccessibilityAnnouncer } from '../../../../platform/accessibility/accessibility-announcer'
import { useMobileScreenReaderOn } from '../../../../platform/accessibility/use-mobile-screen-reader-on'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { mobileNativeChatDisplayCopyText } from '../messages/mobile-native-chat-display-copy'
import {
  mobileAgentMessageLead,
  mobileAgentMessageUnnamed
} from './MobileNativeChatAgentMessageCard'

/** Speaks each waiting agent message that arrives while a screen reader runs and this chat is open
 *  and loaded, as its row reads. What already waits when the chat opens, loads or the reader starts
 *  is only recorded; `rows` includes a message being edited, so cancelling the edit says nothing. */
export function useMobileWaitingAgentMailArrivalAnnouncement(
  rows: readonly NativeChatMessage[],
  chat: { key: string; listening: boolean }
): void {
  const t = useMobileTranslation()
  const announce = useAccessibilityAnnouncer()
  const reader = useMobileScreenReaderOn()
  const seen = useRef<{ key: string; ids: ReadonlySet<string> } | null>(null)
  const listening = reader && chat.listening
  useEffect(() => {
    const before = listening && seen.current?.key === chat.key ? seen.current.ids : null
    seen.current = listening ? { key: chat.key, ids: new Set(rows.map((row) => row.id)) } : null
    if (!before) {
      return
    }
    for (const message of rows) {
      if (before.has(message.id) || !message.from) {
        continue
      }
      const heading = agentMessageHeading(message.from, message)
      const name =
        agentMessageSavedName(agentMessagePrimarySender(message.from)) ??
        mobileAgentMessageUnnamed(heading, t)
      const preview = agentMessagePreviewLine(mobileNativeChatDisplayCopyText(message)).line
      const words = mobileAgentMessageLead(heading, t)
      void announce(
        `${words} ${name}, ${t('chat.agentMessage.row.notSentYet', 'not sent yet')}${
          preview ? `: ${preview}` : ''
        }`
      )
    }
  }, [rows, listening, chat.key, announce, t])
}
