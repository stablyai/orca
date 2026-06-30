import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as fs from 'node:fs'
import type { Stats } from 'node:fs'

const { existsSyncMock, statSyncMock, wslUncDirectoryExistsMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  wslUncDirectoryExistsMock: vi.fn()
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    existsSync: existsSyncMock,
    statSync: statSyncMock
  }
})

function dirStats(isDirectory: boolean): Stats {
  return { isDirectory: () => isDirectory } as Stats
}

vi.mock('../wsl', () => ({
  wslUncDirectoryExists: wslUncDirectoryExistsMock
}))

import { validateWorkingDirectory } from './local-pty-utils'

const WSL_UNC_DIR = '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
const NATIVE_DIR = 'C:\\Users\\jin\\repo'

describe('validateWorkingDirectory', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    statSyncMock.mockReset()
    wslUncDirectoryExistsMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts a WSL UNC worktree that exists inside the distro even when fs.statSync would fail', () => {
    // Why: the Win32 9P stat is the exact path that falsely reported ENOENT and
    // broke opening WSL worktrees. The distro answer must win.
    wslUncDirectoryExistsMock.mockReturnValue(true)
    existsSyncMock.mockReturnValue(false)

    expect(() => validateWorkingDirectory(WSL_UNC_DIR)).not.toThrow()
    expect(wslUncDirectoryExistsMock).toHaveBeenCalledWith(WSL_UNC_DIR)
    // The fs fallback must not run when the distro confirmed existence.
    expect(existsSyncMock).not.toHaveBeenCalled()
  })

  it('rejects a WSL UNC worktree that does not exist inside the distro', () => {
    wslUncDirectoryExistsMock.mockReturnValue(false)

    expect(() => validateWorkingDirectory(WSL_UNC_DIR)).toThrow(/does not exist/)
    expect(existsSyncMock).not.toHaveBeenCalled()
  })

  it('falls back to the fs check when the distro answer is inconclusive', () => {
    wslUncDirectoryExistsMock.mockReturnValue(null)
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue(dirStats(true))

    expect(() => validateWorkingDirectory(WSL_UNC_DIR)).not.toThrow()
    expect(wslUncDirectoryExistsMock).toHaveBeenCalledWith(WSL_UNC_DIR)
    expect(existsSyncMock).toHaveBeenCalledWith(WSL_UNC_DIR)
  })

  it('validates native Windows paths via fs without consulting the distro', () => {
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue(dirStats(true))

    expect(() => validateWorkingDirectory(NATIVE_DIR)).not.toThrow()
    expect(wslUncDirectoryExistsMock).not.toHaveBeenCalled()
    expect(existsSyncMock).toHaveBeenCalledWith(NATIVE_DIR)
  })

  it('rejects a missing native Windows path', () => {
    existsSyncMock.mockReturnValue(false)

    expect(() => validateWorkingDirectory(NATIVE_DIR)).toThrow(/does not exist/)
    expect(wslUncDirectoryExistsMock).not.toHaveBeenCalled()
  })

  it('rejects a native Windows path that exists but is not a directory', () => {
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue(dirStats(false))

    expect(() => validateWorkingDirectory(NATIVE_DIR)).toThrow(/is not a directory/)
  })
})
