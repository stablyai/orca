import type { MobileStructuredSendResult } from './mobile-structured-agent-session-send'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatSession } from './use-mobile-native-chat-session'
import type { NativeChatLiveTurnIndicator } from '../../../src/shared/native-chat-turn-status'
import type { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import type { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'
import type { StructuredMobileSendAttachment } from './use-mobile-structured-send-with-outcome'
import type { MobileNativeChatCommandRefusalCauses } from './use-mobile-native-chat-send-error'
import type { MobileStructuredQueuedMessageControls } from './use-mobile-structured-queued-message-controls'
import type { MobileStructuredBackgroundTasks } from './use-mobile-structured-background-tasks'

export type StructuredMobileSession = ReturnType<typeof useMobileStructuredAgentOptions> &
  ReturnType<typeof useMobileStructuredAgentTurnTiming> & {
    session: MobileNativeChatSession
    isWorking: boolean
    turnId: string | null
    /** What labels the live turn's one indicator row. */
    turnIndicator: NativeChatLiveTurnIndicator
    /** The journal records that settle this phone's own sends. */
    submissions: readonly AgentJournalSubmission[]
    sendWithOutcome: (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileSendAttachment[]
    ) => Promise<MobileStructuredSendResult>
    cancel: () => void
    permission: MobileChatPermission | null
    question: MobileChatQuestion | null
    respondPermission: (optionId: string) => Promise<boolean>
    respondQuestion: (answer: string) => Promise<boolean>
    cancelPrompt: (prompt?: { itemId: string; expectedRevision: number }) => Promise<boolean>
    /** The queued-draft cards and their actions, from any host that publishes them. */
    queued: MobileStructuredQueuedMessageControls
    commandRefusalCauses: MobileNativeChatCommandRefusalCauses
    /** Running child work for the strip above the composer, as desktop shows it. */
    backgroundTasks: MobileStructuredBackgroundTasks
    /** Where this chat's `::orca-visual` lines read their HTML from; null without a client. */
    visualSource: MobileNativeChatVisualSource | null
  }
