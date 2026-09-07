import { describe, expect, it } from 'vitest'
import {
  IN_PROGRESS_WINDOW_MS,
  isDevBundleInUse,
  selectStaleDevBundleDirs
} from './dev-electron-bundle-cache.mjs'

const NOW = 1_800_000_000_000
const ROOT = '/repo/out/electron-dev'
const A = `${ROOT}/aaaaaaaaaaaa`
const B = `${ROOT}/bbbbbbbbbbbb`
const C = `${ROOT}/cccccccccccc`

/** A finished bundle: marker present, copied long ago. */
function settled(dir: string) {
  return { dir, hasMarker: true, mtimeMs: NOW - IN_PROGRESS_WINDOW_MS * 2 }
}

/** A `ps -Awwo command=` line for a dev instance running out of `dir`. */
function psLine(dir: string, appName = 'Orca: some-branch') {
  return `${dir}/${appName}.app/Contents/MacOS/Electron --remote-debugging-port=9333`
}

describe('dev-electron-bundle-cache', () => {
  it('reclaims siblings while keeping the current bundle', () => {
    expect(
      selectStaleDevBundleDirs({
        bundles: [settled(A), settled(B), settled(C)],
        currentDir: B,
        processTable: '',
        nowMs: NOW
      })
    ).toEqual([A, C])
  })

  it('never reclaims a bundle a live process is running from', () => {
    // Deleting a bundle out from under a live Electron process can crash it mid-session, and
    // developers routinely run several dev instances at once.
    expect(
      selectStaleDevBundleDirs({
        bundles: [settled(A), settled(B), settled(C)],
        currentDir: B,
        processTable: psLine(A),
        nowMs: NOW
      })
    ).toEqual([C])
  })

  it('protects a live bundle whose path contains spaces', () => {
    // Regression: an extraction regex using \S* could not cross a space, so any developer with a
    // space in their checkout path got "nothing is live" and had the running bundle deleted.
    const spaced = '/Users/me/My Projects/orca/out/electron-dev/aaaaaaaaaaaa'
    const other = '/Users/me/My Projects/orca/out/electron-dev/bbbbbbbbbbbb'
    expect(
      selectStaleDevBundleDirs({
        bundles: [settled(spaced), settled(other)],
        currentDir: C,
        processTable: psLine(spaced, 'Orca: my branch'),
        nowMs: NOW
      })
    ).toEqual([other])
  })

  it('does not treat a sibling as live just because it shares a prefix', () => {
    // Boundary: `<dir>2` being live must not protect `<dir>`. Without the trailing slash in the
    // needle, `A` would be found inside `A2`'s path and wrongly spared.
    const a2 = `${A}2`
    expect(
      selectStaleDevBundleDirs({
        bundles: [settled(A), settled(a2)],
        currentDir: C,
        processTable: psLine(a2),
        nowMs: NOW
      })
    ).toEqual([A])
  })

  it('never deletes a bundle that is still being copied', () => {
    // Between mkdirSync and the marker write there is a ~270MB copy taking tens of seconds, during
    // which the directory exists, has no marker, and cannot appear in `ps` because its instance has
    // not launched yet. A concurrently starting instance would otherwise delete it mid-copy.
    const inFlight = { dir: A, hasMarker: false, mtimeMs: NOW - 30_000 }
    expect(
      selectStaleDevBundleDirs({
        bundles: [inFlight, settled(B)],
        currentDir: C,
        processTable: '',
        nowMs: NOW
      })
    ).toEqual([B])
  })

  it('reclaims a marker-less bundle once it is too old to be in flight', () => {
    // A build that crashed partway leaves the same signature; only age separates it from the case
    // above, otherwise abandoned debris would be protected forever.
    const abandoned = { dir: A, hasMarker: false, mtimeMs: NOW - IN_PROGRESS_WINDOW_MS - 1 }
    expect(
      selectStaleDevBundleDirs({
        bundles: [abandoned],
        currentDir: C,
        processTable: '',
        nowMs: NOW
      })
    ).toEqual([A])
  })

  it('matches a live bundle across the /tmp and /private/tmp spellings', () => {
    // macOS realpaths /tmp to /private/tmp, and `ps` preserves whatever spelling the process was
    // launched with. A mismatch would read as "not running" and delete a live bundle.
    const priv = '/private/tmp/wt/out/electron-dev/aaaaaaaaaaaa'
    const plain = '/tmp/wt/out/electron-dev/aaaaaaaaaaaa'
    expect(isDevBundleInUse(priv, psLine(plain))).toBe(true)
    expect(isDevBundleInUse(plain, psLine(priv))).toBe(true)
    expect(isDevBundleInUse(priv, psLine('/private/tmp/wt/out/electron-dev/bbbbbbbbbbbb'))).toBe(
      false
    )
  })

  it('still honours the path boundary across spellings', () => {
    const priv = '/private/tmp/wt/out/electron-dev/aaaaaaaaaaaa'
    expect(isDevBundleInUse(priv, psLine('/tmp/wt/out/electron-dev/aaaaaaaaaaaa2'))).toBe(false)
  })

  it('reclaims nothing when every directory is current or live', () => {
    expect(
      selectStaleDevBundleDirs({
        bundles: [settled(A), settled(B)],
        currentDir: A,
        processTable: psLine(B),
        nowMs: NOW
      })
    ).toEqual([])
    expect(
      selectStaleDevBundleDirs({ bundles: [], currentDir: A, processTable: '', nowMs: NOW })
    ).toEqual([])
  })
})
