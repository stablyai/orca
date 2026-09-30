import { setTimeout as delayDefault } from 'node:timers/promises'

export async function openRelayLoadInviteOffers({
  peers,
  count,
  ratePerSecond,
  concurrency = 8,
  delay = delayDefault,
  now = Date.now
}) {
  if (
    !Array.isArray(peers) || peers.length === 0 ||
    !Number.isSafeInteger(count) || count < 0 ||
    !Number.isSafeInteger(ratePerSecond) || ratePerSecond < 1 || ratePerSecond > 20 ||
    !Number.isSafeInteger(concurrency) || concurrency < 1
  ) throw new Error('invalid Relay invite-offer load')
  let next = 0
  let nextStartAt = now()
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    for (;;) {
      const index = next++
      if (index >= count) return
      const scheduledAt = Math.max(nextStartAt, now())
      nextStartAt = scheduledAt + 1_000 / ratePerSecond
      await delay(Math.max(0, scheduledAt - now()))
      await peers[index % peers.length].openInviteOffer()
    }
  })
  await Promise.all(workers)
  return count
}

export async function proveRelayLoadRequestUnitBoundary(peer) {
  try {
    await peer.openInviteOffer()
  } catch (error) {
    if (error instanceof Error && error.message === 'invite offer failed: relay_capacity_exhausted') {
      return 'relay_capacity_exhausted'
    }
    throw new Error('request-unit overflow was not rejected safely', { cause: error })
  }
  throw new Error('request-unit overflow unexpectedly succeeded')
}
