/** Stop causes persist as event reasons; other child-end causes remain memory-only. */
export type StructuredAgentSessionChildEndCause =
  | 'user-stop'
  | 'user-close'
  | 'context-clear'
  | 'host-stop'
  | 'exit'
  | 'attach-failed'
  | 'evict'

/** Persisted JournalStopEvent reasons; never rename arms. */
export type StructuredAgentSessionStopCause = Extract<
  StructuredAgentSessionChildEndCause,
  'user-stop' | 'user-close' | 'context-clear' | 'host-stop' | 'evict'
>
