import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BackgroundDistroGate from '../wsl/discovery/wsl-background-distro-gate'
import type * as NodeFs from 'node:fs'

const mocks = vi.hoisted(() => ({
  readWslDistroRunningState: vi.fn(),
  existsSync: vi.fn((_path: string) => false),
  // Fakes: a real write of a UNC path off Windows would land in the working directory.
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  loadHooks: vi.fn((_path: string) => null)
}))

vi.mock('../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundDistroGate>()),
  readWslDistroRunningState: mocks.readWslDistroRunningState
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  existsSync: mocks.existsSync,
  writeFileSync: mocks.writeFileSync,
  mkdirSync: mocks.mkdirSync,
  rmSync: mocks.rmSync
}))
vi.mock('../git/source-control/ignores/check-ignored-paths', () => ({
  checkIgnoredPaths: vi.fn(async () => new Set(['']))
}))
vi.mock('./hooks', () => ({ loadHooks: mocks.loadHooks }))

import {
  readIssueCommandUnlessWslStopped,
  writeIssueCommandUnlessWslStopped
} from './issue-command-file'

const WSL_REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const HOST_REPO = 'C:\\src\\repo'

describe('issue command reads for a stopped WSL distro (E9)', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.readWslDistroRunningState.mockReset().mockResolvedValue('stopped')
    mocks.existsSync.mockClear()
    mocks.loadHooks.mockClear()
    mocks.writeFileSync.mockClear()
    mocks.rmSync.mockClear()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('returns the unreachable result for a background read, never touching the distro', async () => {
    await expect(readIssueCommandUnlessWslStopped(WSL_REPO)).resolves.toMatchObject({
      status: 'error',
      localContent: null,
      sharedContent: null,
      effectiveContent: null,
      source: 'none',
      localFilePath: expect.stringContaining('issue-command'),
      refusedWslDistro: 'Ubuntu'
    })
    expect(mocks.existsSync).not.toHaveBeenCalled()
    expect(mocks.loadHooks).not.toHaveBeenCalled()
  })

  it("refuses a write the user didn't make, leaving the hidden file and the distro alone", async () => {
    await expect(writeIssueCommandUnlessWslStopped(WSL_REPO, 'x', {})).rejects.toThrow(
      "WSL distro 'Ubuntu' is not running"
    )
    await expect(writeIssueCommandUnlessWslStopped(WSL_REPO, '', {})).rejects.toThrow()
    expect(mocks.writeFileSync).not.toHaveBeenCalled()
    expect(mocks.rmSync).not.toHaveBeenCalled()
  })

  it('refuses a host-path repo whose Git runs in the stopped distro', async () => {
    await expect(
      writeIssueCommandUnlessWslStopped(HOST_REPO, 'x', () => ({ wslDistro: 'Ubuntu' }))
    ).rejects.toThrow("WSL distro 'Ubuntu' is not running")
    expect(mocks.writeFileSync).not.toHaveBeenCalled()
  })
})
