export type DaemonStreamDataBatcherOptions = {
  maxLineBytes?: number
  /** onStallTimeout (pause only) bounds a pause whose consumer never drains and never closes. */
  onProducerBackpressureChanged?: (
    sessionId: string,
    paused: boolean,
    onStallTimeout?: () => void
  ) => void
  isSessionAttachedToClient?: (clientId: string, sessionId: string) => boolean
  /** True for sessions whose queued output may be keep-tail dropped (main-marked background sessions). */
  isSessionDroppable?: (sessionId: string) => boolean
  /** Carve reply-eliciting query bytes (DSR/DA/DECRQM/OSC probes) out of dropped data — the hidden program blocks on the reply, so they must still be delivered even when their flood is not. */
  salvageDroppedData?: (dropped: string) => string
}
