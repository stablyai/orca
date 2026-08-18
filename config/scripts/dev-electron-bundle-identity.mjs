// Why this module exists: the dev runner re-signs its copied Electron.app ad-hoc, so the bundle's
// designated requirement is a bare cdhash derived from its contents. macOS Keychain ACLs key off
// that requirement. Patching any branch-varying value into Info.plist therefore gave every branch a
// different code identity, and safeStorage re-prompted for a password on each one.
//
// The invariant: every value patched here must be constant across branches and worktrees, so all dev
// bundles share one cdhash and one Keychain ACL entry. Per-branch Dock names come from the .app
// directory name instead, which is not part of the signature.

export const DEV_BUNDLE_ID = 'com.stablyai.orca.dev'
export const DEV_HELPER_BUNDLE_ID = `${DEV_BUNDLE_ID}.helper`

/** Info.plist patches for the app bundle. Values must not vary per branch — see above. */
export function getDevBundlePlistPatches() {
  return [{ key: 'CFBundleIdentifier', value: DEV_BUNDLE_ID }]
}

/** Info.plist patches for the embedded Electron Helper bundle. */
export function getDevHelperPlistPatches() {
  return [{ key: 'CFBundleIdentifier', value: DEV_HELPER_BUNDLE_ID }]
}
