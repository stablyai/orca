import { useEffect, useRef } from 'react'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import {
  agentMessageHeading,
  agentMessagePrimarySender,
  agentMessageSenderLabel
} from '../../../../../../src/shared/agent-session/view/messages/agent-message-presentation'
import { agentMessagePreviewLine } from '../../../../../../src/shared/agent-session/view/messages/agent-message-preview-line'
import { useAccessibilityAnnouncer } from '../../../../platform/accessibility/accessibility-announcer'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { mobileNativeChatDisplayCopyText } from '../messages/mobile-native-chat-display-copy'
import { mobileAgentMessageLead } from './MobileNativeChatAgentMessageCard'

/** Speaks each waiting agent message that arrives while the chat is open, as its row reads; mail
 *  already waiting when the chat opens is not announced. */
export function useMobileWaitingAgentMailArrivalAnnouncement(
  rows: readonly NativeChatMessage[],
  active: boolean
): void {
  const t = useMobileTranslation()
  const announce = useAccessibilityAnnouncer()
  const seen = useRef<ReadonlySet<string> | null>(null)
  useEffect(() => {
    const before = active ? seen.current : null
    seen.current = active ? new Set(rows.map((row) => row.id)) : null
    if (!before) {
      return
    }
    const unnamed = t('session.agentMessageAttribution.unnamedSender', 'an agent')
    for (const message of rows) {
      if (before.has(message.id) || !message.from) {
        continue
      }
      const sender = agentMessagePrimarySender(message.from)
      const name = sender
        ? agentMessageSenderLabel({
            localChat: false,
            snapshotName: sender.name,
            fallback: unnamed
          })
        : unnamed
      const preview = agentMessagePreviewLine(mobileNativeChatDisplayCopyText(message)).line
      const words = mobileAgentMessageLead(agentMessageHeading(message.from, message), t)
      void announce(
        `${words} ${name}, ${t('chat.agentMessage.row.notSentYet', 'not sent yet')}${
          preview ? `: ${preview}` : ''
        }`
      )
    }
  }, [rows, active, announce, t])
}
