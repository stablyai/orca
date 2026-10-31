export type BrowserHostFenceReason = 'replaced' | 'released' | 'lease_released' | 'lease_replaced'

export type BrowserHostFence = {
  promise: Promise<BrowserHostFenceReason>
  resolve: (reason: BrowserHostFenceReason) => void
}

export function createBrowserHostFence(): BrowserHostFence {
  let settled = false
  let settle = (_reason: BrowserHostFenceReason): void => {}
  const promise = new Promise<BrowserHostFenceReason>((resolve) => {
    settle = resolve
  })
  return {
    promise,
    resolve: (reason) => {
      if (settled) {
        return
      }
      settled = true
      settle(reason)
    }
  }
}
