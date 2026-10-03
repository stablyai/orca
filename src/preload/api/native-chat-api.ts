import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import type {
  NativeChatDraftStoreResult,
  PersistedNativeChatDraft,
  SavedNativeChatDraft
} from '../../shared/native-chat-draft-record'

// notFound marks a not-yet-on-disk miss (retry-worthy) vs a real read/parse error (#8401).
export type NativeChatReadSessionResult =
  | {
      messages: NativeChatMessage[]
      lifecycle?: NativeChatTurnLifecycle
    }
  | { error: string; notFound?: true }

/** Messages appended to a live-tailed transcript since the previous emit. */
export type NativeChatAppendedMessages = NativeChatMessage[]

export type NativeChatSubscriptionFrame =
  | {
      type: 'snapshot'
      messages: NativeChatMessage[]
      hasMore: boolean
      error?: string
      lifecycle?: NativeChatTurnLifecycle
      /** No transcript exists behind this window yet — render it, but do not
       *  treat it as a settled read of the session's history. */
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

/** Wire payload for the `nativeChat:appended` push channel. */
export type NativeChatAppendedPayload = {
  subscriptionId: string
  frame: NativeChatSubscriptionFrame
}

export type NativeChatSubscribeArgs = {
  /** Unique per-caller id, echoed on every append so multiple live panes in
   *  one renderer don't cross-talk. */
  subscriptionId: string
  agent: AgentType
  sessionId: string
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
  /** First snapshot size; later readSession calls grow this for pagination. */
  limit?: number
}

export type NativeChatApi = {
  /** Read the on-disk transcript for an agent + session id, windowed to the most recent `limit`
   *  turns. `transcriptPath` is the hook-reported authoritative path, preferred over the id glob. */
  readSession: (
    agent: AgentType,
    sessionId: string,
    limit?: number,
    transcriptPath?: string
  ) => Promise<NativeChatReadSessionResult>
  /** Live-tail a transcript. The first frame is a bounded race-safe snapshot;
   *  later frames contain only newly appended messages. */
  subscribe: (
    args: NativeChatSubscribeArgs,
    onFrame: (frame: NativeChatSubscriptionFrame) => void
  ) => () => void
  /** Composer drafts: kept by the main process on desktop, in browser storage in the web client. */
  drafts: NativeChatDraftsApi
}

export type NativeChatDraftsApi = {
  /** Every saved draft, oldest first. */
  load: () => Promise<SavedNativeChatDraft[]>
  /** The same, blocking; only for a renderer that needs drafts before `load` returned. */
  loadSync: () => SavedNativeChatDraft[]
  /** `null` clears. Resolves once written to the file (no fsync), or once the write failed. */
  write: (
    scopeKey: string,
    draft: PersistedNativeChatDraft | null
  ) => Promise<NativeChatDraftStoreResult>
  /**
   * Save a send's clear at Enter instead of once the host has the message. Browser storage reaches
   * disk lazily anyway, and clearing first frees the quota the outbox append shares with drafts.
   */
  savesSendClearAtOnce?: true
  /** Another window changed a draft; only where several windows share one draft store. */
  onExternalChange?: (
    listener: (scopeKey: string, draft: PersistedNativeChatDraft | null) => void
  ) => void
}
