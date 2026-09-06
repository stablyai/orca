import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEV_BUNDLE_MARKER_FILENAME,
  getDevBundleProcessTable,
  selectStaleDevBundleDirs
} from './dev-electron-bundle-cache.mjs'
import { collectDevBundles } from './reclaim-dev-electron-bundles.mjs'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

function makeWorktree(bundles: { name: string; marker: boolean }[]): string {
  const worktree = mkdtempSync(path.join(tmpdir(), 'orca-dev-bundles-'))
  roots.push(worktree)
  for (const bundle of bundles) {
    const dir = path.join(worktree, 'out', 'electron-dev', bundle.name)
    mkdirSync(dir, { recursive: true })
    if (bundle.marker) {
      writeFileSync(path.join(dir, DEV_BUNDLE_MARKER_FILENAME), '{}')
    }
  }
  return worktree
}

describe('collectDevBundles', () => {
  it('reports each bundle and whether its build finished', () => {
    const worktree = makeWorktree([
      { name: 'aaaa', marker: true },
      { name: 'bbbb', marker: false }
    ])
    const bundles = collectDevBundles(worktree).sort((a, b) => a.dir.localeCompare(b.dir))
    expect(bundles).toHaveLength(2)
    expect(bundles[0].hasMarker).toBe(true)
    expect(bundles[1].hasMarker).toBe(false)
    expect(bundles[0].mtimeMs).toBeGreaterThan(0)
  })

  it('returns nothing for a worktree that has never run the dev app', () => {
    const worktree = mkdtempSync(path.join(tmpdir(), 'orca-dev-bundles-'))
    roots.push(worktree)
    expect(collectDevBundles(worktree)).toEqual([])
  })
})

describe('sweeping across worktrees', () => {
  it('spares a bundle a live process is running from, and takes the idle ones', () => {
    const worktree = makeWorktree([
      { name: 'live', marker: true },
      { name: 'idle', marker: true }
    ])
    const bundles = collectDevBundles(worktree)
    const live = bundles.find((bundle) => bundle.dir.endsWith('live'))!
    // Why currentDir is null here: unlike the dev runner, the sweep is not about to launch
    // anything, so only a live process or an in-flight build may protect a bundle.
    const stale = selectStaleDevBundleDirs({
      bundles,
      currentDir: null,
      processTable: `/usr/bin/foo ${live.dir}/Orca.app/Contents/MacOS/Electron`,
      nowMs: Date.now()
    })
    expect(stale).toEqual([bundles.find((bundle) => bundle.dir.endsWith('idle'))!.dir])
  })

  it('spares a build still in flight, which has no marker yet', () => {
    const worktree = makeWorktree([{ name: 'building', marker: false }])
    const stale = selectStaleDevBundleDirs({
      bundles: collectDevBundles(worktree),
      currentDir: null,
      processTable: '',
      nowMs: Date.now()
    })
    expect(stale).toEqual([])
  })
})

describe('getDevBundleProcessTable', () => {
  it('returns null rather than an empty table when ps fails', () => {
    expect(
      getDevBundleProcessTable(() => {
        throw new Error('ps unavailable')
      })
    ).toBeNull()
  })

  it('reads the real process table on this host', () => {
    const table = getDevBundleProcessTable()
    expect(typeof table === 'string' || table === null).toBe(true)
  })
})
