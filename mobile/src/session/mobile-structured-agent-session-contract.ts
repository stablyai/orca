import type { RpcClient } from '../transport/rpc-client'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import type { MobileChatQuestion } from './mobile-native-chat-question'
import type { MobileNativeChatSession } from './use-mobile-native-chat-session'
import type { NativeChatLiveTurnIndicator } from '../../../src/shared/native-chat-turn-status'
import type { NativeChatResolvedPrompt } from '../../../src/shared/native-chat-resolution-receipt'
import type { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import type { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'
import type { StructuredMobileSendAttachment } from './use-mobile-structured-send-with-outcome'
import type {
  MobileNativeChatCommandRefusalCauses,
  MobileNativeChatSendErrorReporter
} from './native-chat/use-mobile-native-chat-send-error'
import type { MobileStructuredQueuedMessageControls } from './use-mobile-structured-queued-message-controls'
import type { MobileStructuredBackgroundTasks } from './use-mobile-structured-background-tasks'

export type StructuredMobileSession = ReturnType<typeof useMobileStructuredAgentOptions> &
  ReturnType<typeof useMobileStructuredAgentTurnTiming> & {
    session: MobileNativeChatSession
    isWorking: boolean
    turnId: string | null
    turnIndicator: NativeChatLiveTurnIndicator
    sendWithOutcome: (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileSendAttachment[]
    ) => Promise<MobileNativeChatSendOutcome>
    cancel: () => void
    receipts: ReadonlyMap<string, NativeChatResolvedPrompt>
    /** Undefined from a host too old to say. */
    actionablePromptIds: readonly string[] | undefined
    permission: MobileChatPermission | null
    question: MobileChatQuestion | null
    respondPermission: (optionId: string) => Promise<boolean>
    respondQuestion: (answer: string) => Promise<boolean>
    cancelPrompt: (prompt?: { itemId: string; expectedRevision: number }) => Promise<boolean>
    queued: MobileStructuredQueuedMessageControls
    commandRefusalCauses: MobileNativeChatCommandRefusalCauses
    backgroundTasks: MobileStructuredBackgroundTasks
    visualSource: MobileNativeChatVisualSource | null
    imagePreviewsByMessageId: Record<string, string[]>
  }

export type MobileStructuredAgentSessionArgs = {
  client: RpcClient | null
  sessionId: string | null
  /** Host/workspace scope used to keep same provider ids isolated. */
  sourceIdentity?: string
  enabled: boolean
  /** Live transport only; gates the connection-scoped hold, and whether child rows may read live. */
  connected: boolean
  /** Capability facts from the shared runtime status probe; null follows the legacy wire. */
  hostSupport: StructuredAgentSessionHostSupport | null
  agent: string | null
  appendComposerText?: (text: string) => boolean
  onSendError: MobileNativeChatSendErrorReporter
  // Accepted queued actions retire the route’s failure banner.
  onActionResolved?: () => void
}
