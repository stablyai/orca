import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AppUpdateState } from './app-update-checker'
import { useWallAppUpdate } from './use-wall-app-update'
import { useWallAppUpdate as usePageWallAppUpdate } from './use-wall-app-update.web'

const runtime = vi.hoisted(() => {
  const state: { snapshot: AppUpdateState } = {
    snapshot: { lastCheckedAt: null, available: null, dismissedVersion: null, checking: false }
  }
  return state
})

vi.mock('./app-update-runtime', () => ({ useAppUpdateState: () => runtime.snapshot }))

const RELEASE = { version: '0.0.52', url: 'https://example.test/0.0.52' }

describe('useWallAppUpdate', () => {
  it('offers a release dismissed on home, because it is the way past the wall', () => {
    runtime.snapshot = {
      lastCheckedAt: 1,
      available: RELEASE,
      dismissedVersion: RELEASE.version,
      checking: false
    }
    expect(useWallAppUpdate()).toEqual(RELEASE)
  })

  it('offers nothing when no release is known', () => {
    runtime.snapshot = {
      lastCheckedAt: 1,
      available: null,
      dismissedVersion: null,
      checking: false
    }
    expect(useWallAppUpdate()).toBeNull()
  })
})

describe('the page form of useWallAppUpdate', () => {
  it('offers nothing', () => {
    expect(usePageWallAppUpdate()).toBeNull()
  })

  // CI's page-closure pin does not count modules, so this is the only guard on this page path.
  it('imports only types, so the page bundle never carries the checker', () => {
    const source = readFileSync(join(import.meta.dirname, 'use-wall-app-update.web.ts'), 'utf8')
    const imports = source.split('\n').filter((line) => line.startsWith('import'))
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.every((line) => line.startsWith('import type '))).toBe(true)
  })
})
