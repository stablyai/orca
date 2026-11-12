import type * as crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeTestStores, createStore, testState, writeDataFile } from '../persistence-test-harness'
import { isOfficialTelemetryBuild } from '../../telemetry/official-build'
import { resolveFirstLaunchLayout } from '../loading-store/profile-loading/first-launch-layout'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/official-build', () => ({
  isOfficialTelemetryBuild: vi.fn(() => true)
}))
const draw = vi.hoisted(() => ({ value: 0, calls: 0 }))
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof crypto>()),
  randomInt: () => {
    draw.calls += 1
    return draw.value
  }
}))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-first-launch-layout-'))
  draw.value = 0
  draw.calls = 0
  vi.mocked(isOfficialTelemetryBuild).mockReturnValue(true)
})
afterEach(async () => {
  await closeTestStores()
  vi.unstubAllEnvs()
  rmSync(testState.dir, { recursive: true, force: true })
})

function homeRepoNames(store: ReturnType<typeof createStore>): string[] {
  return store.getRepos().map((repo) => repo.displayName)
}

describe('first launch layout for a missing desktop profile', () => {
  it('opens the home workspace and remembers it through restart', async () => {
    const store = createStore({ initializeHomeWorkspace: true })
    expect(store.getSettings().telemetry?.firstLaunchLayout).toBe('home-workspace')
    expect(homeRepoNames(store)).toEqual(['~'])
    store.flush()
    await closeTestStores()

    const reopened = createStore({ initializeHomeWorkspace: true })
    expect(reopened.getSettings().telemetry?.firstLaunchLayout).toBe('home-workspace')
    expect(homeRepoNames(reopened)).toEqual(['~'])
    expect(draw.calls).toBe(1)
  })

  it('starts on the landing page without a workspace and remembers it through restart', async () => {
    draw.value = 1
    const store = createStore({ initializeHomeWorkspace: true })
    expect(store.getSettings().telemetry?.firstLaunchLayout).toBe('project-picker')
    expect(store.getRepos()).toEqual([])
    store.flush()
    await closeTestStores()

    draw.value = 0
    const reopened = createStore({ initializeHomeWorkspace: true })
    expect(reopened.getSettings().telemetry?.firstLaunchLayout).toBe('project-picker')
    expect(reopened.getRepos()).toEqual([])
    expect(draw.calls).toBe(1)
  })

  it('leaves saved profiles untouched, including empty ones', () => {
    writeDataFile({ repos: [] })
    const store = createStore({ initializeHomeWorkspace: true })
    expect(store.getSettings().telemetry?.firstLaunchLayout).toBeUndefined()
    expect(store.getRepos()).toEqual([])
    expect(draw.calls).toBe(0)
  })

  it('leaves headless and remote stores untouched', () => {
    const store = createStore({ initializeHomeWorkspace: false })
    expect(store.getSettings().telemetry?.firstLaunchLayout).toBeUndefined()
    expect(store.getRepos()).toEqual([])
    expect(draw.calls).toBe(0)
  })

  it('keeps development builds in the home workspace without recording a layout', () => {
    vi.mocked(isOfficialTelemetryBuild).mockReturnValue(false)
    const store = createStore({ initializeHomeWorkspace: true })
    expect(store.getSettings().telemetry?.firstLaunchLayout).toBeUndefined()
    expect(homeRepoNames(store)).toEqual(['~'])
    expect(draw.calls).toBe(0)
  })
})

describe('pinned first launch layout', () => {
  it('honors a pinned layout only outside release builds', () => {
    const env = { ORCA_FIRST_LAUNCH_LAYOUT: 'project-picker' }
    expect(resolveFirstLaunchLayout(false, env)).toBe('project-picker')
    expect(resolveFirstLaunchLayout(false, { ORCA_FIRST_LAUNCH_LAYOUT: 'other' })).toBeUndefined()
    expect(resolveFirstLaunchLayout(true, env)).toBe('home-workspace')
  })

  it('applies a pinned layout to a development profile', () => {
    vi.mocked(isOfficialTelemetryBuild).mockReturnValue(false)
    vi.stubEnv('ORCA_FIRST_LAUNCH_LAYOUT', 'project-picker')
    const store = createStore({ initializeHomeWorkspace: true })
    expect(store.getSettings().telemetry?.firstLaunchLayout).toBe('project-picker')
    expect(store.getRepos()).toEqual([])
  })
})
