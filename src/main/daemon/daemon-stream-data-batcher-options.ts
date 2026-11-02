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
  /** Carve reply-eliciting query bytes (DSR/DA/DECRQM/OSC probes) out of dropped data — the hidden program blocks on the reply, so they must still be delivered even when their flood is not. */
  salvageDroppedData?: (
    dropped: string,
    maxChars: number,
    end?: number,
    accept?: (chars: number) => boolean
  ) => string
}
