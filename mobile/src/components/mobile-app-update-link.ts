const IOS_APP_STORE_URL = 'itms-apps://apps.apple.com/app/orca-ide/id6766130217'
// Why: filter to mobile release tags so daily desktop releases don't bury the
// newest APK; deliberately version-agnostic so the link never goes stale.
const ANDROID_RELEASES_URL = 'https://github.com/stablyai/orca/releases?q=mobile-android'

// Why: Android ships from GitHub releases while iOS ships through the App
// Store; both surfaces always show the newest build without naming a version.
export function getMobileAppUpdateUrl(platform: string): string | null {
  if (platform === 'ios') {
    return IOS_APP_STORE_URL
  }
  if (platform === 'android') {
    return ANDROID_RELEASES_URL
  }
  return null
}
