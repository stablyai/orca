import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatVisualTheme } from '../../../shared/native-chat/visuals/native-chat-visual-shell'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../shared/native-chat/native-chat-types'

// notFound marks a not-yet-on-disk miss (retry-worthy) vs a real read/parse error (#8401).
export type NativeChatReadSessionResult =
  | {
      messages: NativeChatMessage[]
      lifecycle?: NativeChatTurnLifecycle
      /** Older rows exist before this window; absent from hosts that predate cursor paging. */
      hasMore?: boolean
      beforeOffset?: number
    }
  | { error: string; notFound?: true }

export type NativeChatAppendedMessages = NativeChatMessage[]

export type NativeChatSubscriptionFrame =
  | {
      type: 'snapshot'
      messages: NativeChatMessage[]
      hasMore: boolean
      error?: string
      lifecycle?: NativeChatTurnLifecycle
      /** No transcript yet; do not treat this frame as settled session history. */
      pending?: boolean
    }
  | {
      type: 'replacement'
      messages: NativeChatMessage[]
      hasMore: boolean
      lifecycle?: NativeChatTurnLifecycle
    }
  | {
      type: 'appended'
      messages: NativeChatMessage[]
      lifecycle?: NativeChatTurnLifecycle
    }

export type NativeChatAppendedPayload = {
  subscriptionId: string
  frame: NativeChatSubscriptionFrame
}

export type NativeChatSubscribeArgs = {
  /** Unique per caller to isolate live panes sharing a renderer. */
  subscriptionId: string
  agent: AgentType
  sessionId: string
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
  /** First snapshot size; later readSession calls grow this for pagination. */
  limit?: number
  /** The user opened this chat: may start its stopped local WSL distro (E9). */
  wakeWslDistro?: boolean
}

export type NativeChatReadSessionOptions = {
  wakeWslDistro?: boolean
  /** Provider row cursor: read only rows strictly older than it. */
  beforeOffset?: number
}

export type NativeChatApi = {
  /** Desktop-only appearance snapshot for ordinary chat-created HTML file guests. */
  publishVisualGuestTheme?: (theme: NativeChatVisualTheme) => void
  /** Reads the latest limit turns; the hook-reported transcriptPath takes precedence over ID globbing. */
  readSession: (
    agent: AgentType,
    sessionId: string,
    limit?: number,
    transcriptPath?: string,
    /** The user opened or paged this chat: may start its stopped local WSL distro (E9). */
    options?: NativeChatReadSessionOptions
  ) => Promise<NativeChatReadSessionResult>
  /** First frame is a bounded snapshot; later frames contain only appended messages. */
  subscribe: (
    args: NativeChatSubscribeArgs,
    onFrame: (frame: NativeChatSubscriptionFrame) => void
  ) => () => void
  /** A local structured chat's last failed naming output; null when none or not local. */
  getConversationNameFailureOutput: (sessionId: string) => Promise<string | null>
}
