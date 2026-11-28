export type DaemonStreamDataBatcherOptions = {
  maxLineBytes?: number
  /** onStallTimeout applies while paused and releases producers whose consumers neither drain nor close; false means the pause was declined. */
  onProducerBackpressureChanged?: (
    sessionId: string,
    paused: boolean,
    onStallTimeout?: (reason: 'input' | 'timeout' | 'released' | 'terminating' | 'exited') => void
  ) => boolean | 'terminating' | 'exited' | 'detached' | void
  isSessionAttachedToClient?: (clientId: string, sessionId: string) => boolean
  isSessionDroppable?: (sessionId: string) => boolean
  /** Preserve terminal queries in dropped output: the hidden program may be waiting for their replies. */
  salvageDroppedData?: (dropped: string) => string
  /** Rate-limited report of a pause of 2 s or more or a watchdog release; ids and sizes only. */
  onLongProducerPause?: (details: Record<string, unknown>) => void
  /** The producer incarnation holding a session id, so pause records never carry over a respawn. */
  incarnationOf?: (sessionId: string) => string | undefined
}
