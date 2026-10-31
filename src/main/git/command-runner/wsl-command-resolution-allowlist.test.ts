import type * as ChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, execFileSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn()
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawn: spawnMock,
  execFileSync: execFileSyncMock
}))
vi.mock('../../wsl-background-distro-gate', () => ({ noteWslDistroLaunched: vi.fn() }))

import { resolveCommand } from './wsl-command-resolution'
import { gitExecFileSync } from './git-exec-file-sync'
import { gitSpawn } from './git-spawn'
import { wslAwareSpawn } from './wsl-aware-spawn'

const ALLOWLIST = 'ORCA_INTERNAL_WSL_DISTRO_ALLOWLIST'
const REFUSED = { code: 'ORCA_WSL_DISTRO_NOT_ALLOWLISTED' }
const UBUNTU_REPO = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  vi.unstubAllEnvs()
  spawnMock.mockReset()
  execFileSyncMock.mockReset()
})

describe('resolveCommand under the internal WSL distro allowlist', () => {
  it('unset: resolves exactly as with the distro allowlisted, without throwing', () => {
    vi.stubEnv(ALLOWLIST, undefined)
    const unset = [
      resolveCommand('git', ['status'], UBUNTU_REPO),
      resolveCommand('gh', ['auth', 'status'], undefined, 'Ubuntu', { useWslLoginShell: true }),
      resolveCommand('git', ['status'], 'C:\\repo')
    ]
    vi.stubEnv(ALLOWLIST, 'ubuntu')
    const allowlisted = [
      resolveCommand('git', ['status'], UBUNTU_REPO),
      resolveCommand('gh', ['auth', 'status'], undefined, 'Ubuntu', { useWslLoginShell: true }),
      resolveCommand('git', ['status'], 'C:\\repo')
    ]

    expect(unset).toEqual(allowlisted)
    expect(unset[0]).toMatchObject({ binary: 'wsl.exe', wslMode: 'non-login-shell' })
    expect(unset[2]).toMatchObject({ binary: 'git', wsl: null })
  })

  it('refuses a WSL resolution into another distro, but never a Windows-host one', () => {
    vi.stubEnv(ALLOWLIST, 'orca-test-a')

    expect(() => resolveCommand('git', ['status'], UBUNTU_REPO)).toThrow(
      expect.objectContaining(REFUSED)
    )
    expect(() => resolveCommand('gh', ['auth', 'status'], undefined, 'Ubuntu')).toThrow(
      expect.objectContaining(REFUSED)
    )
    expect(resolveCommand('git', ['status'], 'C:\\repo')).toMatchObject({ binary: 'git' })
  })

  it('refuses through every direct child_process git spawn path before a child starts', () => {
    vi.stubEnv(ALLOWLIST, 'orca-test-a')

    expect(() => gitExecFileSync(['status'], { cwd: UBUNTU_REPO, hostGit: true })).toThrow(
      expect.objectContaining(REFUSED)
    )
    expect(() => gitSpawn(['status'], { cwd: UBUNTU_REPO })).toThrow(
      expect.objectContaining(REFUSED)
    )
    expect(() => wslAwareSpawn('rg', ['--files'], { cwd: UBUNTU_REPO })).toThrow(
      expect.objectContaining(REFUSED)
    )
    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
