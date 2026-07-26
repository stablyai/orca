const LEASE_READY_POLL_MS = 100
const LEASE_READY_TIMEOUT_MS = 3000

export async function waitForMobileInputLeaseReady(args: {
  isCurrent: () => boolean
  isReady: () => boolean
}): Promise<boolean> {
  const deadline = Date.now() + LEASE_READY_TIMEOUT_MS
  while (args.isCurrent() && !args.isReady() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LEASE_READY_POLL_MS))
  }
  return args.isCurrent() && args.isReady()
}
