/** Why a provider child ended. In memory only, except `user-stop`, the one arm a Stop event
 *  journals so far. */
export type StructuredAgentSessionChildEndCause =
  | 'user-stop'
  /** The user closed this chat: its tab, its launch, or a `/clear` that replaces it. */
  | 'user-close'
  | 'host-stop'
  | 'exit'
  | 'attach-failed'
  | 'evict'

/** Why the host asked a child to stop. The adapter carries it onto the `ended` it settles with,
 *  and a Stop event persists it (`JournalStopEvent.reason`), so never rename an arm. */
export type StructuredAgentSessionStopCause = Extract<
  StructuredAgentSessionChildEndCause,
  'user-stop' | 'user-close' | 'host-stop' | 'evict'
>
