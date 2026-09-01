import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslModule from '../wsl'

const { execFileMock, execFileSyncMock, spawnMock, getDefaultWslDistroMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))

vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getDefaultWslDistro: getDefaultWslDistroMock
}))

import { setDefaultWslDistroOverride } from '../git/runner'
import { _resetKnownHostsCache, getGlabKnownHosts } from './gitlab-known-host-probe'

describe('glab known-hosts probe on Windows', () => {
  const originalPlatform = process.platform

  const hostGlabMissingWslLoggedIn = (): void => {
    execFileMock.mockImplementation((binary, _args, _options, callback) => {
      if (binary === 'wsl.exe') {
        callback(null, { stdout: 'Logged in to gitlab.wsl.test as user', stderr: '' })
        return
      }
      callback(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }))
    })
  }

  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
    getDefaultWslDistroMock.mockReset()
    getDefaultWslDistroMock.mockReturnValue('Ubuntu')
    setDefaultWslDistroOverride(null)
    _resetKnownHostsCache()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    setDefaultWslDistroOverride(null)
    _resetKnownHostsCache()
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('does not wake the default WSL distro for the native execution key', async () => {
    hostGlabMissingWslLoggedIn()

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com'])

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock).toHaveBeenCalledWith(
      'glab',
      ['auth', 'status'],
      expect.objectContaining({ cwd: undefined }),
      expect.any(Function)
    )
  })

  // Why: glab has no SSH/relay dispatch, so a connection-keyed probe and the
  // `glab api` calls it gates both run the local CLI with no cwd. Suppressing the
  // fallback here would make the probe disagree with those calls.
  it('keeps the default-distro fallback for a connection execution key', async () => {
    hostGlabMissingWslLoggedIn()

    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual(['gitlab.com', 'gitlab.wsl.test'])

    expect(execFileMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'bash', '-c', "'glab' 'auth' 'status'"],
      expect.objectContaining({ cwd: undefined }),
      expect.any(Function)
    )
  })
})
