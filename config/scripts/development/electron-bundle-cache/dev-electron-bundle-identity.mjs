// Keep all signed Info.plist values branch-invariant: ad-hoc cdhash is the Keychain ACL identity, so branch drift re-prompts for passwords.
// Branch Dock names belong in the unsigned .app directory name.

export const DEV_BUNDLE_ID = 'com.stablyai.orca.dev'
export const DEV_HELPER_BUNDLE_ID = `${DEV_BUNDLE_ID}.helper`
// Fixed display name distinguishes dev notifications from other Electron apps without branch-specific signature drift.
export const DEV_BUNDLE_DISPLAY_NAME = 'Orca Dev'

/** Info.plist patches for the app bundle. Values must not vary per branch — see above. */
export function getDevBundlePlistPatches() {
  return [
    { key: 'CFBundleIdentifier', value: DEV_BUNDLE_ID },
    { key: 'CFBundleName', value: DEV_BUNDLE_DISPLAY_NAME },
    { key: 'CFBundleDisplayName', value: DEV_BUNDLE_DISPLAY_NAME }
  ]
}

/** Info.plist patches for the embedded Electron Helper bundle. */
export function getDevHelperPlistPatches() {
  return [{ key: 'CFBundleIdentifier', value: DEV_HELPER_BUNDLE_ID }]
}
