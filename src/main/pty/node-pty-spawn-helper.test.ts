import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as fs from 'node:fs'
import type { Stats } from 'node:fs'
import type * as SpawnHelper from './node-pty-spawn-helper'

const { existsSyncMock, statSyncMock, chmodSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  chmodSyncMock: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    existsSync: existsSyncMock,
    statSync: statSyncMock,
    chmodSync: chmodSyncMock
  }
})

function modeStats(mode: number): Stats {
  return { mode } as Stats
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

// Why resetModules per test: the repair latches on a module-level flag after its first run.
async function loadHelperRepair(): Promise<typeof SpawnHelper> {
  vi.resetModules()
  return import('./node-pty-spawn-helper')
}

beforeEach(() => {
  existsSyncMock.mockReset()
  statSyncMock.mockReset()
  chmodSyncMock.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

describe('ensureNodePtySpawnHelperExecutable', () => {
  it('repairs the prebuild helper even when build/Release is already executable', async () => {
    const { ensureNodePtySpawnHelperExecutable, getNodePtySpawnHelperCandidates } =
      await loadHelperRepair()
    const [releaseHelper, debugHelper, prebuildHelper] = getNodePtySpawnHelperCandidates()
    existsSyncMock.mockImplementation((path: string) => path !== debugHelper)
    statSyncMock.mockImplementation((path: string) =>
      modeStats(path === releaseHelper ? 0o100755 : 0o100644)
    )

    ensureNodePtySpawnHelperExecutable()

    // The regression: returning at the already-+x build/Release left the packaged prebuild at
    // 644, so node-pty's prebuild fallback spawned it and died with EACCES.
    expect(chmodSyncMock).toHaveBeenCalledTimes(1)
    expect(chmodSyncMock).toHaveBeenCalledWith(prebuildHelper, 0o100644 | 0o755)
  })

  it('repairs every non-executable candidate that exists', async () => {
    const { ensureNodePtySpawnHelperExecutable, getNodePtySpawnHelperCandidates } =
      await loadHelperRepair()
    const candidates = getNodePtySpawnHelperCandidates()
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue(modeStats(0o100644))

    ensureNodePtySpawnHelperExecutable()

    expect(chmodSyncMock.mock.calls.map(([path]) => path)).toEqual(candidates)
  })

  it('leaves an already-executable candidate untouched', async () => {
    const { ensureNodePtySpawnHelperExecutable } = await loadHelperRepair()
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue(modeStats(0o100755))

    ensureNodePtySpawnHelperExecutable()

    expect(chmodSyncMock).not.toHaveBeenCalled()
  })

  it('keeps repairing after one candidate fails to chmod', async () => {
    const { ensureNodePtySpawnHelperExecutable, getNodePtySpawnHelperCandidates } =
      await loadHelperRepair()
    const [releaseHelper, , prebuildHelper] = getNodePtySpawnHelperCandidates()
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue(modeStats(0o100644))
    chmodSyncMock.mockImplementation((path: string) => {
      if (path === releaseHelper) {
        throw new Error('EPERM: operation not permitted')
      }
    })

    ensureNodePtySpawnHelperExecutable()

    expect(chmodSyncMock).toHaveBeenCalledWith(prebuildHelper, 0o100644 | 0o755)
  })

  it('skips candidates that are not installed', async () => {
    const { ensureNodePtySpawnHelperExecutable, getNodePtySpawnHelperCandidates } =
      await loadHelperRepair()
    const [, , prebuildHelper] = getNodePtySpawnHelperCandidates()
    existsSyncMock.mockImplementation((path: string) => path === prebuildHelper)
    statSyncMock.mockReturnValue(modeStats(0o100644))

    ensureNodePtySpawnHelperExecutable()

    expect(chmodSyncMock).toHaveBeenCalledTimes(1)
    expect(chmodSyncMock).toHaveBeenCalledWith(prebuildHelper, 0o100644 | 0o755)
  })

  it('does nothing on Windows, where node-pty has no spawn-helper', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const { ensureNodePtySpawnHelperExecutable } = await loadHelperRepair()
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue(modeStats(0o100644))

    ensureNodePtySpawnHelperExecutable()

    expect(chmodSyncMock).not.toHaveBeenCalled()
  })
})
