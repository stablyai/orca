export type DaemonStreamDataBatcherOptions = {
  maxLineBytes?: number
  /** onStallTimeout applies while paused and releases producers whose consumers neither drain nor close. */
  onProducerBackpressureChanged?: (
    sessionId: string,
    paused: boolean,
    onStallTimeout?: () => void
  ) => void
  isSessionAttachedToClient?: (clientId: string, sessionId: string) => boolean
  isSessionDroppable?: (sessionId: string) => boolean
  /** Preserve terminal queries in dropped output: the hidden program may be waiting for their replies. */
  salvageDroppedData?: (dropped: string) => string
}
