import type { MacosUpgradeSupport } from '../../shared/macos-12-support-notice/upgrade-support'

// Ventura's Intel model boundaries: https://support.apple.com/en-us/102861.
const VENTURA_INTEL_MODELS = {
  MacBook: [10, 10],
  MacBookAir: [8, 9],
  MacBookPro: [14, 16],
  Macmini: [8, 8],
  iMac: [18, 20],
  iMacPro: [1, 1],
  MacPro: [7, 7]
} as const

export function getIntelMacos13Support(modelIdentifier: string): MacosUpgradeSupport['macos13'] {
  const match =
    /^(MacBookAir|MacBookPro|MacBook|Macmini|iMacPro|iMac|MacPro)([1-9]\d*),[1-9]\d*$/u.exec(
      modelIdentifier
    )
  if (!match) {
    return 'unknown'
  }
  const family = match[1]
  const limits = Object.entries(VENTURA_INTEL_MODELS).find(([name]) => name === family)?.[1]
  if (!limits) {
    return 'unknown'
  }
  const major = Number(match[2])
  if (major < limits[0]) {
    return 'unsupported'
  }
  return major <= limits[1] ? 'supported' : 'unknown'
}
