import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSpawnDispatch } from '../../shared/child-process/__fixtures__/fake-spawned-child'
import type * as WslModule from '../wsl'

const { execFileSyncMock, spawnMock, getDefaultWslDistroMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: vi.fn(),
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
    spawnMock.mockImplementation(
      fakeSpawnDispatch((program) =>
        program === 'wsl.exe'
          ? { stdout: 'Logged in to gitlab.wsl.test as user' }
          : { spawnError: Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }) }
      )
    )
  }

  beforeEach(() => {
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

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      'glab',
      ['auth', 'status'],
      expect.objectContaining({ cwd: undefined })
    )
  })

  // Why: glab has no SSH/relay dispatch, so a connection-keyed probe and the
  // `glab api` calls it gates both run the local CLI with no cwd. Suppressing the
  // fallback here would make the probe disagree with those calls.
  it('keeps the default-distro fallback for a connection execution key', async () => {
    hostGlabMissingWslLoggedIn()

    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual(['gitlab.com', 'gitlab.wsl.test'])

    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--exec', 'bash', '-c', "'glab' 'auth' 'status'"],
      // Why a concrete directory (#16463): `undefined` makes CreateProcessW inherit
      // Orca's own cwd, a deletable WSL UNC path when it was launched from a
      // worktree. This probe has no repo directory at all, so nothing about where
      // it runs changes. The native `glab` assertion above keeps `undefined`.
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })
})
