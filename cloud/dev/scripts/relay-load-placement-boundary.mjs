export async function proveRelayLoadPlacementBoundary({ peer, failureReason }) {
  let connected = false
  try {
    await peer.connect()
    connected = true
  } catch (error) {
    const reason = failureReason(error)
    if (reason !== 'assignment_capacity_exhausted') {
      throw new Error(`placement overflow was not rejected: ${reason}`)
    }
    return reason
  } finally {
    await peer.shutdown()
  }
  if (connected) throw new Error('placement overflow unexpectedly connected')
}

export async function proveRelayLoadRegionalFallback({ peer, blockedOrigin }) {
  try {
    await peer.connect()
    const assignedOrigin = peer.assignedCellUrl()
    if (!assignedOrigin || assignedOrigin === blockedOrigin) {
      throw new Error('regional fallback did not leave the full preferred cell')
    }
    return true
  } finally {
    await peer.shutdown()
  }
}
