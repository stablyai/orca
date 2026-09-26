import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEV_BUNDLE_MARKER_FILENAME } from './dev-electron-bundle-cache.mjs'
import {
  pruneRemovedWorktreeElectronApps,
  readDevBundleSourceAppPath
} from './dev-bundle-worktree-ownership.mjs'

let cacheRoot: string

function writeBundle(name: string, marker: unknown): string {
  const dir = join(cacheRoot, name)
  mkdirSync(dir, { recursive: true })
  if (marker !== undefined) {
    writeFileSync(join(dir, DEV_BUNDLE_MARKER_FILENAME), JSON.stringify(marker))
  }
  return dir
}

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'orca-dev-bundle-owner-'))
})

afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true })
})

describe('dev-bundle-worktree-ownership', () => {
  it('reads the owning worktree source path from a bundle marker', () => {
    const owned = writeBundle('owned', { sourceAppPath: '/wt/node_modules/electron/dist' })
    const malformed = writeBundle('malformed', { sourceAppPath: 42 })
    const markerless = writeBundle('markerless', undefined)

    expect(readDevBundleSourceAppPath(owned)).toBe('/wt/node_modules/electron/dist')
    expect(readDevBundleSourceAppPath(malformed)).toBeNull()
    expect(readDevBundleSourceAppPath(markerless)).toBeNull()
  })

  // Why skipped on Windows: the prune reads /bin/ps, and the dev bundle only exists on macOS.
  it.skipIf(process.platform === 'win32')(
    'prunes only idle bundles whose owning worktree was removed',
    () => {
      const current = writeBundle('current', {
        sourceAppPath: join(cacheRoot, 'gone-current'),
        appBundleName: 'Orca current.app'
      })
      const removed = writeBundle('removed', {
        sourceAppPath: join(cacheRoot, 'gone'),
        appBundleName: 'Orca removed.app'
      })
      const existingOwner = writeBundle('existing-owner', {
        sourceAppPath: cacheRoot,
        appBundleName: 'Orca existing.app'
      })
      const markerless = writeBundle('markerless', undefined)

      pruneRemovedWorktreeElectronApps(cacheRoot, current)

      expect(existsSync(current)).toBe(true)
      expect(existsSync(removed)).toBe(false)
      expect(existsSync(existingOwner)).toBe(true)
      expect(existsSync(markerless)).toBe(true)
    }
  )
})
