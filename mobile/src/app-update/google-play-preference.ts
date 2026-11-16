// Google Play is unreachable from mainland China, so GitHub installs there must keep updating from GitHub.
// Anywhere else a GitHub install is steered to Play, which updates it in place (same signing key).

// Mainland China's zones; Hong Kong, Macau and Taiwan reach Play and are not listed.
const MAINLAND_CHINA_TIME_ZONES: ReadonlySet<string> = new Set([
  'Asia/Shanghai',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Urumqi',
  'Asia/Kashgar',
  'PRC'
])

export type DeviceRegionSignals = {
  /** Region subtags of the phone's preferred languages, such as `CN` for zh-Hans-CN. */
  readonly regionCodes: readonly (string | null | undefined)[]
  readonly timeZone: string | null | undefined
}

/**
 * True when either signal says mainland China. A phone set to US English but sitting in a Chinese
 * time zone is still behind the firewall, so either signal alone is enough.
 */
export function isLikelyInMainlandChina(signals: DeviceRegionSignals): boolean {
  if (signals.regionCodes.some((code) => code?.toUpperCase() === 'CN')) {
    return true
  }
  return signals.timeZone != null && MAINLAND_CHINA_TIME_ZONES.has(signals.timeZone)
}

/** A GitHub install is pointed at Play only where Play works and the Play Store app can open it. */
export function shouldPreferGooglePlay(input: {
  readonly isAndroid: boolean
  readonly isRetiredApp: boolean
  readonly isInstalledByPlay: boolean
  readonly playStoreUsable: boolean
  readonly inMainlandChina: boolean
}): boolean {
  return (
    input.isAndroid &&
    !input.isRetiredApp &&
    !input.isInstalledByPlay &&
    input.playStoreUsable &&
    !input.inMainlandChina
  )
}
