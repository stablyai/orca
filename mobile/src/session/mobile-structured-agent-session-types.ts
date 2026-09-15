import type { StructuredAgentSessionAttachment } from '../../../src/shared/structured-agent-session-outbox'
import type { NativeChatLiveTurnIndicator } from '../../../src/shared/native-chat-turn-status'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatSession } from './use-mobile-native-chat-session'
import type { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import type { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'

export type StructuredMobileAttachment = StructuredAgentSessionAttachment & {
  id?: string
  contentFingerprint?: string
}

export type StructuredMobileSession = ReturnType<typeof useMobileStructuredAgentOptions> &
  ReturnType<typeof useMobileStructuredAgentTurnTiming> & {
    session: MobileNativeChatSession
    isWorking: boolean
    turnId: string | null
    /** What labels the live turn's one indicator row. */
    turnIndicator: NativeChatLiveTurnIndicator
    sendWithOutcome: (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileAttachment[]
    ) => Promise<MobileNativeChatSendOutcome>
    cancel: () => void
    permission: MobileChatPermission | null
    question: MobileChatQuestion | null
    respondPermission: (optionId: string) => Promise<boolean>
    respondQuestion: (answer: string) => Promise<boolean>
    cancelPrompt: (prompt?: { itemId: string; expectedRevision: number }) => Promise<boolean>
  }
