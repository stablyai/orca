import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'

// notFound marks a not-yet-on-disk miss (retry-worthy) vs a real read/parse error (#8401).
export type NativeChatReadSessionResult =
  | {
      messages: NativeChatMessage[]
      lifecycle?: NativeChatTurnLifecycle
      /** The host counted a record behind the returned window (the same
       *  measurement the snapshot frames carry). Absent from a host too old to
       *  report one, whose fixed window must then be graded against that legacy
       *  default rather than the requested limit (XLR-R3-003). */
      hasMore?: boolean
      /** Byte offset of the OLDEST returned record — pass it straight back as
       *  `beforeOffset` to read the page before it (XLR-R1-001). Growing `limit`
       *  saturates at the wire ceiling, so offset continuation is the only thing
       *  that keeps records past it reachable. Absent from a host too old to
       *  report one, which pins pagination at the ceiling exactly as before. */
      beforeOffset?: number
    }
  | { error: string; notFound?: true }

/** Messages appended to a live-tailed transcript since the previous emit. */
export type NativeChatAppendedMessages = NativeChatMessage[]

/** Set by a client bridge that had to synthesize `hasMore` from the returned
 *  count because the emitting runtime omitted it. Such a value is an exact-fill
 *  guess, not the host counting past the limit, so consumers must grade it no
 *  higher than a local read (SA-011, native-chat-pagination.ts). Absent on every
 *  frame whose `hasMore` came from the emitter. */
type NativeChatInferredHasMore = { hasMoreInferred?: true }

export type NativeChatSubscriptionFrame =
  | ({
      type: 'snapshot'
      messages: NativeChatMessage[]
      hasMore: boolean
      error?: string
      lifecycle?: NativeChatTurnLifecycle
      /** No transcript exists behind this window yet — render it, but do not
       *  treat it as a settled read of the session's history. */
      pending?: boolean
    } & NativeChatInferredHasMore)
  | ({
      type: 'replacement'
      messages: NativeChatMessage[]
      hasMore: boolean
      lifecycle?: NativeChatTurnLifecycle
    } & NativeChatInferredHasMore)
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
    transcriptPath?: string,
    /** Read the window ENDING before this byte offset instead of the live tail —
     *  the continuation cursor a previous result's `beforeOffset` produced. */
    beforeOffset?: number
  ) => Promise<NativeChatReadSessionResult>
  /** Live-tail a transcript. The first frame is a bounded race-safe snapshot;
   *  later frames contain only newly appended messages. */
  subscribe: (
    args: NativeChatSubscribeArgs,
    onFrame: (frame: NativeChatSubscriptionFrame) => void
  ) => () => void
}
