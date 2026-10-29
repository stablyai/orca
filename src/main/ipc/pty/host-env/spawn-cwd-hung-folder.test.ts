import type * as Fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type DirectoryStats = { isDirectory(): boolean }

const { statMock, statSyncMock } = vi.hoisted(() => ({
  statMock: vi.fn<(path: string) => Promise<DirectoryStats>>(),
  statSyncMock: vi.fn<(path: string) => DirectoryStats>()
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statMock
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof Fs>()),
  statSync: statSyncMock
}))

import { localStartupCwdDirectoryExists } from './spawn-cwd'

const HUNG_DIR = '/Volumes/nas/repo/src'
const directoryStats = { isDirectory: () => true }

function blockFor(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // Stands in for a statSync that waits on a dead mount.
  }
}

beforeEach(() => {
  statMock.mockReset()
  statSyncMock.mockReset()
})

describe('the worktree-fallback folder check on a mount that stopped answering', () => {
  it('never blocks the main thread on the folder', async () => {
    statSyncMock.mockImplementation(() => {
      blockFor(300)
      return directoryStats
    })
    statMock.mockResolvedValue(directoryStats)

    const startedAt = performance.now()
    const exists = localStartupCwdDirectoryExists(HUNG_DIR)
    expect(performance.now() - startedAt).toBeLessThan(100)
    expect(statSyncMock).not.toHaveBeenCalled()
    await expect(exists).resolves.toBe(true)
  })

  it('keeps main responsive while a hung folder check waits', async () => {
    statMock.mockReturnValue(new Promise<DirectoryStats>(() => {}))
    const settled = vi.fn()
    void Promise.resolve(localStartupCwdDirectoryExists(HUNG_DIR)).then(settled, settled)

    const timerFired = await new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 10))
    expect(timerFired).toBe(true)
    expect(settled).not.toHaveBeenCalled()
  })

  it('still reads a missing folder as missing so the start can fall back', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(Promise.resolve(localStartupCwdDirectoryExists(HUNG_DIR))).resolves.toBe(false)
  })
})
