export type MobileWebShellConnectionMetrics = {
  reconnectAttempts: number
  lastConnectedAt: number | null
}

export function nextMobileWebShellConnectionMetrics(
  previous: MobileWebShellConnectionMetrics,
  incoming: Partial<MobileWebShellConnectionMetrics>,
  retainExisting: boolean
): MobileWebShellConnectionMetrics {
  return {
    reconnectAttempts:
      incoming.reconnectAttempts ?? (retainExisting ? previous.reconnectAttempts : 0),
    lastConnectedAt:
      incoming.lastConnectedAt === undefined
        ? retainExisting
          ? previous.lastConnectedAt
          : null
        : incoming.lastConnectedAt
  }
}
