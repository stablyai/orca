import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import type { ResolveSessionFileOptions } from './session-file-resolver'

export type SubscribeNativeChatTranscriptArgs = ResolveSessionFileOptions & {
  agent: AgentType
  sessionId: string
  onAppend: (messages: NativeChatMessage[], lifecycle?: NativeChatTurnLifecycle) => void
  onInitialSnapshot?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    /** Set when the initial drain could not deliver a transcript. */
    error?: string,
    lifecycle?: NativeChatTurnLifecycle
  ) => void
  /** The transcript file does not exist yet (a session whose agent has not
   *  flushed, or has not been prompted at all). Fires at most once, before any
   *  snapshot, so a client can settle its view on the empty window it really
   *  has instead of spinning — while still knowing the read is not settled. */
  onTranscriptPending?: () => void
  onReplace?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    lifecycle?: NativeChatTurnLifecycle
  ) => void
  initialLimit?: number
  filePath?: string
  debounceMs?: number
  /** Test-only override for the production resolve-poll backoff. */
  resolvePollIntervalMs?: number
  /** Test-only override for the host-side watcher reconciliation interval. */
  reconciliationIntervalMs?: number
}

export type NativeChatTranscriptSubscription = {
  unsubscribe: () => void
  watching: boolean
}
