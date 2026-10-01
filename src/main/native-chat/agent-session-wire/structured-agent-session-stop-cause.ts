/** Why a provider child ended. In memory only: never journaled, persisted or sent. */
export type StructuredAgentSessionChildEndCause =
  | 'user-stop'
  /** The user closed this chat: its tab, its launch, or a `/clear` that replaces it. */
  | 'user-close'
  | 'host-stop'
  | 'exit'
  | 'attach-failed'
  | 'evict'

/** Why the host asked a child to stop. The adapter carries it onto the `ended` it settles with. */
export type StructuredAgentSessionStopCause = Extract<
  StructuredAgentSessionChildEndCause,
  'user-stop' | 'user-close' | 'host-stop' | 'evict'
>
