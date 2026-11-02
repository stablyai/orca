import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
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
  it.each([
    ['--apply', '--exclude-worktree'],
    ['--exclude-worktree', '--apply'],
    ['--exclude-worktree', '-invalid', '--apply']
  ])('rejects invalid exclusion operands before cleanup: %j', async (...flags) => {
    const worktree = makeWorktree([{ name: 'idle', marker: true }])
    const initialized = await runProcess({ program: 'git', args: ['-C', worktree, 'init', '-q'] })
    expect(initialized.code).toBe(0)
    const result = await runProcess({
      program: process.execPath,
      args: [
        path.join(import.meta.dirname, 'reclaim-dev-electron-bundles.mjs'),
        '--repo',
        worktree,
        ...flags
      ]
    })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('--exclude-worktree requires a directory')
    expect(existsSync(path.join(worktree, 'out', 'electron-dev', 'idle'))).toBe(true)
  })

  it.skipIf(process.platform !== 'darwin')(
    'previews and removes only bundles outside the retention window',
    async () => {
      const worktree = makeWorktree([
        { name: 'old', marker: true },
        { name: 'recent', marker: true }
      ])
      const initialized = await runProcess({ program: 'git', args: ['-C', worktree, 'init', '-q'] })
      expect(initialized.code).toBe(0)
      const old = path.join(worktree, 'out', 'electron-dev', 'old')
      const recent = path.join(worktree, 'out', 'electron-dev', 'recent')
      const aged = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
      utimesSync(old, aged, aged)
      const args = [
        path.join(import.meta.dirname, 'reclaim-dev-electron-bundles.mjs'),
        '--repo',
        worktree,
        '--min-age-days',
        '7'
      ]
      const preview = await runProcess({ program: process.execPath, args })
      expect(preview.code, preview.stderr).toBe(0)
      expect(preview.stdout).toContain('Would remove 1 bundle(s)')
      expect(existsSync(old)).toBe(true)
      const excluded = await runProcess({
        program: process.execPath,
        args: [...args, '--exclude-worktree', worktree, '--apply']
      })
      expect(excluded.code, excluded.stderr).toBe(0)
      expect(existsSync(old)).toBe(true)
      const applied = await runProcess({ program: process.execPath, args: [...args, '--apply'] })
      expect(applied.code, applied.stderr).toBe(0)
      expect(existsSync(old)).toBe(false)
      expect(existsSync(recent)).toBe(true)
    }
  )

  it('spares a bundle a live process is running from, and takes the idle ones', () => {
    const worktree = makeWorktree([
      { name: 'live', marker: true },
      { name: 'idle', marker: true }
    ])
    const bundles = collectDevBundles(worktree)
    const live = bundles.find((bundle) => bundle.dir.endsWith('live'))!
    // No launch follows sweep; null currentDir leaves only live process/in-flight build protection.
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
})
