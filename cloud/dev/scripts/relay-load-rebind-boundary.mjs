export async function waitForRelayLoadRebindGate({
  delay,
  delayMs,
  activeCount,
  requiredCount
}) {
  await delay(delayMs)
  const active = activeCount()
  if (active !== requiredCount) {
    throw new Error(`rebind boundary requires ${requiredCount} active controls, found ${active}`)
  }
}

export async function proveRelayLoadRebindBoundary({
  peers,
  probeCount,
  holdMs,
  delay,
  failureReason,
  requireOverflow = true
}) {
  if (probeCount === 0) return { opened: 0, overflowReason: null }
  if (peers.length < probeCount) throw new Error('insufficient active controls for rebind proof')

  const probes = []
  try {
    const opened = await Promise.allSettled(
      peers.slice(0, probeCount).map((peer) => peer.openRebindProbe())
    )
    for (const result of opened) {
      if (result.status === 'fulfilled') probes.push(result.value)
    }
    const rejected = opened.find((result) => result.status === 'rejected')
    if (rejected) throw rejected.reason

    let overflowReason = null
    if (requireOverflow) {
      try {
        const overflow = await peers[0].openRebindProbe()
        await overflow.close()
      } catch (error) {
        overflowReason = failureReason(error)
      }
      if (overflowReason !== 'socket_http_503') {
        throw new Error(`rebind overflow was not rejected at the hard cap: ${overflowReason}`)
      }
    }
    const closedIndex = await Promise.race([
      delay(holdMs).then(() => -1),
      ...probes.map((probe, index) => probe.closed.then(() => index))
    ])
    if (closedIndex >= 0 || probes.some((probe) => !probe.isOpen())) {
      throw new Error('rebind probe closed before the hold completed')
    }
    return { opened: probes.length, overflowReason }
  } finally {
    await Promise.all(probes.map((probe) => probe.close()))
  }
}
