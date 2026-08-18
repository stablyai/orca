import { describe, expect, it } from 'vitest'
import {
  DEV_BUNDLE_DISPLAY_NAME,
  DEV_BUNDLE_ID,
  DEV_HELPER_BUNDLE_ID,
  getDevBundlePlistPatches,
  getDevHelperPlistPatches
} from './dev-electron-bundle-identity.mjs'

/** Collect the patch set as it would be computed on a given branch. */
function patchesUnder(dockTitle: string, branch: string) {
  const saved = { ...process.env }
  Object.assign(process.env, {
    ORCA_DEV_DOCK_TITLE: dockTitle,
    ORCA_DEV_BRANCH: branch,
    ORCA_DEV_INSTANCE_LABEL: branch,
    ORCA_DEV_WORKTREE_NAME: branch
  })
  try {
    return [...getDevBundlePlistPatches(), ...getDevHelperPlistPatches()]
  } finally {
    process.env = saved
  }
}

describe('dev-electron-bundle-identity', () => {
  it('patches a stable bundle id for the app and its helper', () => {
    expect(getDevHelperPlistPatches()).toEqual([
      { key: 'CFBundleIdentifier', value: DEV_HELPER_BUNDLE_ID }
    ])
    expect(DEV_HELPER_BUNDLE_ID.startsWith(`${DEV_BUNDLE_ID}.`)).toBe(true)
  })

  it('gives the dev app a legible display name so notifications are not just "Electron"', () => {
    const byKey = Object.fromEntries(
      getDevBundlePlistPatches().map((patch) => [patch.key, patch.value])
    )
    expect(byKey.CFBundleName).toBe(DEV_BUNDLE_DISPLAY_NAME)
    expect(byKey.CFBundleDisplayName).toBe(DEV_BUNDLE_DISPLAY_NAME)
    expect(DEV_BUNDLE_DISPLAY_NAME).not.toBe('Electron')
  })

  it('produces byte-identical patches on two different branches', () => {
    // The invariant the whole fix rests on. Info.plist is inside the signature seal, so any
    // branch-derived value moves the ad-hoc cdhash — and macOS Keychain ACLs match on that cdhash,
    // which is what made every branch re-prompt for a password.
    //
    // Compared across two simulated branch environments rather than pattern-matched against
    // suspicious substrings: a denylist only catches branches whose names happen to contain the
    // banned words, and would miss the likeliest regression of all — re-adding
    // `{ key: 'CFBundleName', value: title }` for an ordinary branch like "fix-login-crash".
    expect(patchesUnder('Orca: fix-login-crash', 'fix-login-crash')).toEqual(
      patchesUnder('Orca: perf-2', 'perf-2')
    )
    expect(patchesUnder('Orca: dev', 'main')).toEqual(
      patchesUnder('Orca: some-worktree @ feature/x', 'feature/x')
    )
  })

  it('leaks no branch, worktree, or title text into any patched value', () => {
    const branch = 'fix-login-crash'
    const worktree = 'Orca-safe-storage-lock'
    for (const patch of patchesUnder(`Orca: ${branch}`, branch)) {
      expect(patch.value).not.toContain(branch)
      expect(patch.value).not.toContain(worktree)
      expect(typeof patch.value).toBe('string')
      expect(patch.value.length).toBeGreaterThan(0)
    }
  })
})
