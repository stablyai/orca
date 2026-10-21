/**
 * What a failed screen's Retry does: re-dial a host that needs it, otherwise re-read.
 *
 * Null when re-dialling is the answer and this document cannot dial (the page, where the shell
 * owns the connection): a Retry that can only do nothing is not offered, and the screen's load
 * re-runs on its own when the shell's client reconnects.
 */
export function connectionRetryAction(args: {
  hostId: string | undefined
  needsReconnect: boolean
  forceReconnect: ((hostId: string) => unknown) | null
  reload: () => void
}): (() => void) | null {
  const { hostId, needsReconnect, forceReconnect, reload } = args
  if (!needsReconnect || !hostId) {
    return reload
  }
  return forceReconnect === null ? null : () => void forceReconnect(hostId)
}
