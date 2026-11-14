import type { AgentSessionSlashCommand } from '../../../../../src/shared/agent-session/agent-session-wire'
import type { NativeChatSendFollowUp } from '../../../../../src/shared/native-chat/input/native-chat-follow-up-behavior'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import type {
  MobileNativeChatSendIntent,
  MobileNativeChatSendOutcome
} from '../composer/mobile-native-chat-send'
import type { MobileNativeChatVisualSource } from '../visual/mobile-native-chat-visual-read'
import type { MobileChatPermission } from '../input/mobile-native-chat-permission'
import type { MobileChatQuestion } from '../input/mobile-native-chat-question'
import type { MobileNativeChatSession } from '../use-mobile-native-chat-session'
import type { NativeChatLiveTurnIndicator } from '../../../../../src/shared/native-chat/transcript/native-chat-turn-status'
import type { NativeChatResolvedPrompt } from '../../../../../src/shared/native-chat/native-chat-resolution-receipt'
import type { useMobileStructuredAgentOptions } from '../input/use-mobile-structured-agent-options'
import type { useMobileStructuredAgentTurnTiming } from '../transcript/use-mobile-structured-agent-turn-timing'
import type { StructuredMobileSendAttachment } from '../composer/use-mobile-structured-send-with-outcome'
import type {
  AgentJournalSkillRef,
  AgentJournalSubmission
} from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type {
  MobileNativeChatCommandRefusalCauses,
  MobileNativeChatSendErrorReporter
} from '../composer/use-mobile-native-chat-send-error'
import type { MobileStructuredQueuedMessageControls } from '../input/use-mobile-structured-queued-message-controls'
import type { MobileStructuredBackgroundTasks } from '../input/use-mobile-structured-background-tasks'
import type { NativeChatContextUsageSummary } from '../../../../../src/shared/native-chat/native-chat-context-usage-summary'
import type { MobileStructuredInterruptedContinue } from '../composer/use-mobile-structured-interrupted-continue'
import type { MobileStructuredThreadGoal } from '../input/use-mobile-structured-thread-goal'
import type { MobileStructuredSends } from '../composer/use-mobile-structured-sends'
import type { AgentSessionRewindSurface } from '../../../../../src/shared/agent-session/lifecycle/agent-session-rewind-request'
import type { MobileNativeChatUsageLimit } from '../use-mobile-native-chat-usage-limit'

export type StructuredMobileSession = Omit<
  ReturnType<typeof useMobileStructuredAgentOptions>,
  'contextUsageSupport'
> &
  ReturnType<typeof useMobileStructuredAgentTurnTiming> & {
    /** The composer ring's readout; null until the session reports usage. */
    contextUsage: NativeChatContextUsageSummary | null
    submissions: readonly AgentJournalSubmission[]
    session: MobileNativeChatSession
    asyncQuestionSourceScope: string
    isWorking: boolean
    /** Desktop's Stop rule: a running turn, or conversation Stop while working or sending. */
    canStop: boolean
    /** While the agent works on a host that queues: what a tap on Send does and whether holding it offers the other way; null otherwise. */
    sendFollowUp: NativeChatSendFollowUp | null
    turnId: string | null
    turnIndicator: NativeChatLiveTurnIndicator
    sendWithOutcome: (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredMobileSendAttachment[],
      skills?: readonly AgentJournalSkillRef[],
      intent?: MobileNativeChatSendIntent
    ) => Promise<MobileNativeChatSendOutcome>
    holdUnconfirmed: MobileStructuredSends['holdUnconfirmed']
    cancel: () => void
    receipts: ReadonlyMap<string, NativeChatResolvedPrompt>
    /** Undefined from a host too old to say. */
    actionablePromptIds: readonly string[] | undefined
    permission: MobileChatPermission | null
    question: MobileChatQuestion | null
    respondPermission: (optionId: string) => Promise<boolean>
    respondQuestion: (answer: string, prompt?: MobileChatQuestion['prompt']) => Promise<boolean>
    cancelPrompt: (prompt?: { itemId: string; expectedRevision: number }) => Promise<boolean>
    queued: MobileStructuredQueuedMessageControls
    commandRefusalCauses: MobileNativeChatCommandRefusalCauses
    backgroundTasks: MobileStructuredBackgroundTasks
    interruptedContinue: MobileStructuredInterruptedContinue
    /** Null unless the host reports goals for this chat. */
    threadGoal: MobileStructuredThreadGoal | null
    /** "Rewind to here" for the chat's own turn openers; absent where the chat cannot rewind. */
    rewind: AgentSessionRewindSurface | undefined
    visualSource: MobileNativeChatVisualSource | null
    imagePreviewsByMessageId: Record<string, string[]>
    usageLimit: MobileNativeChatUsageLimit | null
  }

export type MobileStructuredAgentSessionArgs = {
  worktreeId?: string
  client: RpcClient | null
  /** The paired host the route opened: its query cache holds the chat's last model lists. */
  hostId?: string
  /** The route's paired host owns follow-up behavior even when another host executes the chat. */
  pairedHostClient: RpcClient | null
  sessionId: string | null
  /** Host/workspace scope used to keep same provider ids isolated. */
  sourceIdentity?: string
  enabled: boolean
  /** Live transport only; gates the connection-scoped hold, and whether child rows may read live. */
  connected: boolean
  /** Capability facts from the shared runtime status probe; null follows the legacy wire. */
  hostSupport: StructuredAgentSessionHostSupport | null
  agent: string | null
  /** What the session reported for its `/` menu; undefined until read or on an older host. */
  onCommandsChanged?: () => void
  sessionCommands?: readonly AgentSessionSlashCommand[]
  composerScopeKey?: string | null
  appendComposerText?: (text: string) => boolean
  onQueuedEditNotice?: (message: string) => void
  onSendError: MobileNativeChatSendErrorReporter
  // Accepted queued actions retire the route’s failure banner.
  onActionResolved?: () => void
}
