export const MOBILE_WEB_RNW_BUILD_BUDGET = Object.freeze({
  assets: 64,
  compressedBytes: 3 * 1024 * 1024,
  scriptBytes: 19 * 512 * 1024,
  styleBytes: 256 * 1024,
  totalBytes: 10 * 1024 * 1024
})

export function mobileWebRnwBuildBudgetFailures(measurement) {
  return Object.entries(MOBILE_WEB_RNW_BUILD_BUDGET)
    .filter(([key, limit]) => measurement[key] > limit)
    .map(([key]) => key)
}
