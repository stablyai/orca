import { describe, expect, it } from 'vitest'
import { getDevInstanceIdentity } from '../../src/main/startup/dev-instance-identity'
import {
  DEV_BUNDLE_DISPLAY_NAME,
  DEV_BUNDLE_ID,
  DEV_HELPER_BUNDLE_ID,
  getDevBundlePlistPatches,
  getDevHelperPlistPatches
} from './dev-electron-bundle-identity.mjs'

const BRANCH_ENV_KEYS = [
  'ORCA_DEV_DOCK_TITLE',
  'ORCA_DEV_BRANCH',
  'ORCA_DEV_INSTANCE_LABEL',
  'ORCA_DEV_WORKTREE_NAME'
] as const

/** Collect the patch set as it would be computed on a given branch. */
function patchesUnder(dockTitle: string, branch: string) {
  // Restores individual keys rather than reassigning process.env: that swaps Node's native env
  // object for a plain one, which stops coercing assigned values to strings (`env.X = 5` stays a
  // number). Vitest reuses a worker across files, so every later test would inherit the plain object.
  const saved = BRANCH_ENV_KEYS.map((key) => [key, process.env[key]] as const)
  Object.assign(process.env, {
    ORCA_DEV_DOCK_TITLE: dockTitle,
    ORCA_DEV_BRANCH: branch,
    ORCA_DEV_INSTANCE_LABEL: branch,
    ORCA_DEV_WORKTREE_NAME: branch
  })
  try {
    return [...getDevBundlePlistPatches(), ...getDevHelperPlistPatches()]
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('dev-electron-bundle-identity', () => {
  it('leaves process.env untouched, including its object identity', () => {
    const envBefore = process.env
    const snapshot = { ...process.env }
    patchesUnder('Orca: some-branch', 'some-branch')
    expect(process.env).toBe(envBefore)
    expect({ ...process.env }).toEqual(snapshot)
  })

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

  it('keeps the bundle display name in step with the name safeStorage keys off', () => {
    // Two independently hardcoded 'Orca Dev' strings: this one names the bundle (notifications,
    // System Settings), and getDevInstanceIdentity().appName drives app.setName, which decides the
    // Keychain service name. Drift would split the two without anything else failing.
    expect(DEV_BUNDLE_DISPLAY_NAME).toBe(getDevInstanceIdentity(true, {}).appName)
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
