import { describe, expect, it } from 'vitest'
import {
  DEV_BUNDLE_ID,
  DEV_HELPER_BUNDLE_ID,
  getDevBundlePlistPatches,
  getDevHelperPlistPatches
} from './dev-electron-bundle-identity.mjs'

const BRANCH_VARYING_KEYS = ['CFBundleName', 'CFBundleDisplayName']

describe('dev-electron-bundle-identity', () => {
  it('patches a stable bundle id for the app and its helper', () => {
    expect(getDevBundlePlistPatches()).toEqual([
      { key: 'CFBundleIdentifier', value: DEV_BUNDLE_ID }
    ])
    expect(getDevHelperPlistPatches()).toEqual([
      { key: 'CFBundleIdentifier', value: DEV_HELPER_BUNDLE_ID }
    ])
    expect(DEV_HELPER_BUNDLE_ID.startsWith(`${DEV_BUNDLE_ID}.`)).toBe(true)
  })

  it('never patches a key that carried the branch title', () => {
    // Regression: CFBundleName/CFBundleDisplayName held the branch title, so the ad-hoc cdhash
    // changed per branch. Keychain ACLs key off that cdhash, so every branch re-prompted for a
    // password. Per-branch Dock names come from the .app directory name, outside the signature.
    const keys = [...getDevBundlePlistPatches(), ...getDevHelperPlistPatches()].map((p) => p.key)
    for (const branchKey of BRANCH_VARYING_KEYS) {
      expect(keys).not.toContain(branchKey)
    }
  })

  it('produces identical patches regardless of branch, so all dev bundles share one cdhash', () => {
    // The patches take no input, which is the property that keeps the signed content invariant.
    expect(getDevBundlePlistPatches()).toEqual(getDevBundlePlistPatches())
    for (const patch of [...getDevBundlePlistPatches(), ...getDevHelperPlistPatches()]) {
      expect(typeof patch.value).toBe('string')
      expect(patch.value).not.toMatch(/orca[-/]|branch|dev-|@/i)
    }
  })
})
