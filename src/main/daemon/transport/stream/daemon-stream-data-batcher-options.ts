export type DaemonStreamDataBatcherOptions = {
  maxLineBytes?: number
  /** onStallTimeout applies while paused and releases producers whose consumers neither drain nor close; false means the pause was declined. */
  onProducerBackpressureChanged?: (
    sessionId: string,
    paused: boolean,
    onStallTimeout?: (reason: 'input' | 'timeout') => void
  ) => boolean | void
  isSessionAttachedToClient?: (clientId: string, sessionId: string) => boolean
  isSessionDroppable?: (sessionId: string) => boolean
  /** Preserve terminal queries in dropped output: the hidden program may be waiting for their replies. */
  salvageDroppedData?: (dropped: string) => string
}
