// Return null when redial is needed but this page cannot dial; hide inert Retry and let shell reconnection reload the screen.
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
