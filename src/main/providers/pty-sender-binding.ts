export type PtySenderBindingSpawnOptions = {
  /** Require a freshly capability-bound child, replacing an attached child when necessary. */
  restartExistingSessionForSenderBinding?: boolean
  /** Exact fresh generation whose provider-observed old-child exit may be suppressed. */
  senderBindingGeneration?: string
}

export type PtySenderBindingSpawnResult = {
  /** Internal provider acknowledgement; IPC strips this before renderer return. */
  senderBindingGeneration?: string
}

export type PtyExitPayload = {
  id: string
  code: number
  /** Exact fresh generation replacing this intentionally retired old child. */
  replacedBySenderBindingGeneration?: string
}
