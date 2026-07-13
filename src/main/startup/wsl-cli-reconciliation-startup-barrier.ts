export const WSL_CLI_RECONCILIATION_STARTUP_BUDGET_MS = 2_000

type WslCliReconciliationStartupBarrierOptions = {
  timeoutMs?: number
}

/**
 * Briefly gates restored terminals while managed WSL registrations reconcile.
 */
export function createWslCliReconciliationStartupBarrier(
  reconciliation: Promise<unknown>,
  options: WslCliReconciliationStartupBarrierOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? WSL_CLI_RECONCILIATION_STARTUP_BUDGET_MS
  let timeout: ReturnType<typeof setTimeout> | null = null
  const settled = reconciliation
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      if (timeout) {
        clearTimeout(timeout)
      }
    })

  // Why: reconciliation may outlive a slow or unavailable WSL distro; restored
  // terminals should wait briefly without turning WSL discovery into an app hang.
  return Promise.race([
    settled,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs)
    })
  ])
}
