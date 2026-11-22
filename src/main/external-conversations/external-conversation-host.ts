import type { ConversationReplyFill } from './external-conversation-reply-fill'
import type { AgentPaneChange } from '../agent-hooks/observations/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ConnectorActsFor } from '../../shared/connectors/connector-cloud-contract'
import type { DeliveryReceipts } from './external-conversation-delivery-receipts'
import type { ExternalConversationLinkStore } from './external-conversation-links'
import type { ConversationPlaceNamer } from './external-conversation-place'
import type { SlackMirror } from './slack-mirror'
// What the conversation seam reaches on the host it runs for, and the host's clock.
import type { ConversationBots } from './external-conversation-bots'
import type { AskerImages } from './connector-asker-images'
import type { ConversationChatHost } from './external-conversation-chat'
import type { ConversationEventsDeps } from './external-conversation-events'
import type { ConversationWorkersHost } from './external-conversation-workers'

export type ExternalConversationHost = {
  /** Absent where chats are never linked. */
  chat?: ConversationChatHost
  /** Absent where bots never run. */
  bots?: ConversationBots
  /** Absent where chats start no orchestration workers. */
  workers?: ConversationWorkersHost
}

// Pending finishes must not keep the process alive.
export const HOST_CLOCK: Pick<ConversationEventsDeps, 'setTimer' | 'now'> = {
  setTimer: (run, delayMs) => {
    const timer = setTimeout(run, delayMs)
    timer.unref?.()
    return { cancel: () => clearTimeout(timer) }
  },
  now: Date.now
}

export type ExternalConversationSeamDeps = {
  store: ExternalConversationLinkStore
  /** Re-enabling must not settle this process's running deliveries as abandoned leftovers. */
  receipts: DeliveryReceipts
  onWorkspaceRemoved: (listener: (worktreeId: string) => void) => () => void
  /** The hook store's newest row for a pane. */
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  /** The transition detector's pane changes; returns the release. */
  onAgentPaneChange: (listener: (change: AgentPaneChange) => void) => () => void
  /** A conversation was linked to a chat, e.g. so a bot's Activity shows the thread. */
  onLinked?: () => void
  /** A Slack channel's name through Orca Cloud, for a bot conversation's place. */
  nameChannel?: ConversationPlaceNamer
  /** The images a bot's request carries, fetched so its turn sees them; absent, the turn gets words. */
  askerImages?: AskerImages
  /** Whom a bot chat acts for, as its cloud thread keeps it; undefined while Orca hasn't recorded it. */
  actsForOf?: (sessionId: string) => ConnectorActsFor | undefined
  freesGoneChats?: () => boolean
  /** Whether the cloud routes a bot's prompts by who raised them, so it may see prompts of turns
   *  its conversation didn't ask for; absent or false, it sees none of those. */
  promptsAudience?: () => boolean
  /** Fills the reply outbox rows an ended turn answered; null while no journal is open. */
  replyFill?: () => ConversationReplyFill | null
  /** A delivery was admitted to this chat through the reply outbox. */
  replyAdmitted?: (sessionId: string) => void
  /** Whether the journal has filled every reply for this chat, including replies owed by cuts. */
  repliesSettled?: (sessionId: string) => Promise<boolean>
  slackMirror?: () => SlackMirror | null
}
