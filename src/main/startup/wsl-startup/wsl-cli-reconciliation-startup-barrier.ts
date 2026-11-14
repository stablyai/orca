export const WSL_CLI_RECONCILIATION_STARTUP_BUDGET_MS = 2_000

type WslCliReconciliationStartupBarrierOptions = {
  timeoutMs?: number
}

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

  // Bound WSL reconciliation waits so slow/unavailable distros cannot hang terminal startup.
  return Promise.race([
    settled,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs)
    })
  ])
}
