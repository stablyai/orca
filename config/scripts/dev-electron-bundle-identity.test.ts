import { describe, expect, it } from 'vitest'
import {
  DEV_BUNDLE_DISPLAY_NAME,
  DEV_BUNDLE_ID,
  DEV_HELPER_BUNDLE_ID,
  getDevBundlePlistPatches,
  getDevHelperPlistPatches
} from './dev-electron-bundle-identity.mjs'

// Stand-ins for values that used to be interpolated per branch.
const BRANCH_SPECIFIC_SAMPLES = [
  'Orca: nwparker-some-branch',
  'Orca: totally-different-branch',
  'feature/framework-symlinks',
  'Orca: dev'
]

function allPatches() {
  return [...getDevBundlePlistPatches(), ...getDevHelperPlistPatches()]
}

describe('dev-electron-bundle-identity', () => {
  it('patches a stable bundle id for the app and its helper', () => {
    expect(getDevHelperPlistPatches()).toEqual([
      { key: 'CFBundleIdentifier', value: DEV_HELPER_BUNDLE_ID }
    ])
    expect(DEV_HELPER_BUNDLE_ID.startsWith(`${DEV_BUNDLE_ID}.`)).toBe(true)
  })

  it('gives the dev app a legible display name so notifications are not just "Electron"', () => {
    const byKey = Object.fromEntries(allPatches().map((patch) => [patch.key, patch.value]))
    expect(byKey.CFBundleName).toBe(DEV_BUNDLE_DISPLAY_NAME)
    expect(byKey.CFBundleDisplayName).toBe(DEV_BUNDLE_DISPLAY_NAME)
    expect(DEV_BUNDLE_DISPLAY_NAME).not.toBe('Electron')
  })

  it('never patches a value that varies by branch, so all dev bundles share one cdhash', () => {
    // The real invariant. Patching a key is fine; varying its value per branch is not — Info.plist
    // is inside the signature seal, so branch-varying values changed the ad-hoc cdhash, and macOS
    // Keychain ACLs match on that cdhash. Per-branch Dock names come from the .app directory name.
    for (const patch of allPatches()) {
      for (const branch of BRANCH_SPECIFIC_SAMPLES) {
        expect(patch.value).not.toContain(branch)
      }
      expect(patch.value).not.toMatch(/branch|nwparker|feature\/|@/i)
    }
  })

  it('is deterministic — the patch set takes no input', () => {
    expect(getDevBundlePlistPatches()).toEqual(getDevBundlePlistPatches())
    expect(getDevHelperPlistPatches()).toEqual(getDevHelperPlistPatches())
    for (const patch of allPatches()) {
      expect(typeof patch.value).toBe('string')
      expect(patch.value.length).toBeGreaterThan(0)
    }
  })
})
