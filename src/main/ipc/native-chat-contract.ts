import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import type { AgentSessionCurrentRequestsMarker } from '../../shared/agent-session-current-requests-wire'

export type NativeChatReadSessionArgs = {
  agent: AgentType
  sessionId: string
  /** Recent-turn window; increase it to page backward. */
  limit?: number
  /** Hook-authoritative path when session IDs no longer identify transcript filenames. */
  transcriptPath?: string
}

export type NativeChatSubscribeArgs = {
  /** Renderer ID unique within WebContents, echoed on updates to route each viewer. */
  subscriptionId: string
  agent: AgentType
  sessionId: string
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
  limit?: number
}

export type NativeChatAppendedPayload = {
  subscriptionId: string
  frame: { currentRequests?: AgentSessionCurrentRequestsMarker } & (
    | {
        type: 'snapshot'
        messages: NativeChatMessage[]
        hasMore: boolean
        error?: string
        lifecycle?: NativeChatTurnLifecycle
        /** The current window has no transcript yet; do not treat it as settled history. */
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
  )
}
