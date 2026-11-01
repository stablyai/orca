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

function settled(dir: string) {
  return { dir, hasMarker: true, mtimeMs: NOW - IN_PROGRESS_WINDOW_MS * 2 }
}

function psLine(dir: string, appName = 'Orca: some-branch') {
  return `${dir}/${appName}.app/Contents/MacOS/Electron --remote-debugging-port=9333`
}

describe('dev-electron-bundle-cache', () => {
  it('keeps recently used bundles during automatic retention sweeps', () => {
    expect(
      selectStaleDevBundleDirs({
        bundles: [settled(A), { ...settled(B), mtimeMs: NOW - 8 * 24 * 60 * 60 * 1000 }],
        currentDir: null,
        processTable: '',
        nowMs: NOW,
        minAgeMs: 7 * 24 * 60 * 60 * 1000
      })
    ).toEqual([B])
  })
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
    // Deleting a live bundle can crash any of several concurrent dev instances.
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
    // The old \S* extractor missed spaces and deleted live bundles.
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
    // Trailing slash keeps live dir2 from protecting stale dir.
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
    // Between mkdir and marker, a ~270MB copy has no ps entry; concurrent starters must still spare it.
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
    // Only age distinguishes crashed-copy debris from a live unfinished build.
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
    // ps preserves launch spelling while macOS realpath changes /tmp to /private/tmp; test both.
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
