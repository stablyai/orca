import type { PendingPrompt } from '../../shared/agent-status/contracts/agent-pending-prompt'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { ConnectorTurnOrigin } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { LinkedConversation } from './external-conversation-links'
import type { ChatTurnReplies, SlackMirrorTurn } from './external-conversation-turn-ends'
import type { WakeAnswersDeps } from './external-conversation-wake-answers'
import type { ConversationWorkersDeps } from './external-conversation-workers'

/** What ChatTurns reads and writes: status rows, the chats' deliveries, and the link's facts. */
export type ChatTurnsDeps = ConversationWorkersDeps &
  ChatTurnReplies &
  WakeAnswersDeps & {
    readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
    pendingPrompt: (link: ExternalConversationLink) => PendingPrompt | null
    /** Read once per ended turn. */
    chatTurnOrigin: (sessionId: string, turnAt: number | null) => ConnectorTurnOrigin
    /** Whether a delivery was sent to the chat and its turn hasn't ended. */
    chatTurnDelivered: (sessionId: string) => boolean
    /** The delivery a chat turn that began at `turnAt` answers; taken once. */
    chatTurnDelivery: (sessionId: string, turnAt: number) => string | undefined
    /** Whether a delivery the chat took waits for a turn to name it. */
    chatTurnWaiting: (sessionId: string) => boolean
    /** Whether reports from workers its conversation's turns started opened the chat's running turn. */
    runningTurnReported: (sessionId: string) => boolean
    /** Read once per ended turn of a bot conversation. */
    workLinks: (link: ExternalConversationLink) => Promise<ConnectorWorkLink[]>
    /** The ended Orca-typed turn's owner posts to its Slack thread (taken once), else null. */
    mirrorTurn?: (sessionId: string) => SlackMirrorTurn | null
    /** Whom a chat's conversation acts for, as Orca recorded it (ConnectorActsFor). */
    actsForOf?: (sessionId: string) => string | undefined
    /** Whether the cloud routes or masks a prompt by who raised it (prompts.audience). Without
     *  it a prompt of a turn its conversation didn't ask for goes nowhere, as before. */
    promptsAudience: () => boolean
    /** The message that opened the chat's running turn; null when none runs. Read once per shown
     *  prompt, and per watch for a link that kept an adopted turn. */
    turnOpener: (sessionId: string) => AgentJournalRenderItem | null
    /** Keeps (or, with undefined, clears) the adopted turn's opener on the link. */
    turnStartedAt?: (sessionId: string) => number | null
    keepAdoptedTurn: (
      linked: LinkedConversation,
      opener: ExternalConversationLink['adoptedTurn']
    ) => void
    /** A chat's turn ended, heard or not. */
    turnEnded?: (paneKey: string) => void
  }
