import type { HostDiffReviewDeviceOperations } from './host-diff-review-binding'

const unavailable = (): Promise<never> =>
  Promise.reject(new Error('Diff review device operations are unavailable'))

export const DEFAULT_HOST_DIFF_REVIEW_DEVICE_OPERATIONS: HostDiffReviewDeviceOperations = {
  selection() {},
  success() {},
  error() {},
  writeClipboard: unavailable,
  openExternal: unavailable
}
