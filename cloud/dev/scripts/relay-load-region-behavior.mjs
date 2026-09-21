const ASSIGNMENT_RETRY_DELAY_MS = 5_100

const waitPastAssignmentRateLimit = (schedule) =>
  new Promise((resolve) => schedule(resolve, ASSIGNMENT_RETRY_DELAY_MS))

export async function proveRelayLoadRegionBehavior({
  oldClientPeer,
  stickyPeer,
  asiaOrigin,
  scheduleAssignmentRetry = setTimeout
}) {
  try {
    await oldClientPeer.connect()
    if (!oldClientPeer.assignedCellUrl() || oldClientPeer.assignedCellUrl() === asiaOrigin) {
      throw new Error('unhinted client did not use the US-first path')
    }
  } finally {
    await oldClientPeer.shutdown()
  }

  try {
    await stickyPeer.connect()
    if (stickyPeer.assignedCellUrl() !== asiaOrigin) {
      throw new Error('preferred Asia client did not reach the Asia cell')
    }
    await waitPastAssignmentRateLimit(scheduleAssignmentRetry)
    const reassigned = await stickyPeer.requestAssignment('us-central1')
    if (reassigned.cellUrl !== asiaOrigin) {
      throw new Error('valid sticky assignment moved after preference changed')
    }
  } finally {
    await stickyPeer.shutdown()
  }
  return { oldClientUsFirst: true, stickyAssignmentPreserved: true }
}
