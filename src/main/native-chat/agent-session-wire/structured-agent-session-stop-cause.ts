/** Why a provider child ended, for the delivery loop (`lastEndedChild`). A stop's arms are also
 *  its Stop event's reason (`JournalStopEvent`); the others are in memory only. */
export type StructuredAgentSessionChildEndCause =
  | 'user-stop'
  /** The user closed this chat: its tab, its launch, or a `/clear` that replaces it. */
  | 'user-close'
  | 'host-stop'
  | 'exit'
  | 'attach-failed'
  | 'evict'

/** Why a child was asked to stop. A Stop event persists it (`JournalStopEvent.reason`), which
 *  is what a turn's end reads, so never rename an arm. */
export type StructuredAgentSessionStopCause = Extract<
  StructuredAgentSessionChildEndCause,
  'user-stop' | 'user-close' | 'host-stop' | 'evict'
>
