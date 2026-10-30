import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  hasHooksFile: vi.fn((_path: string) => false),
  blocked:
    vi.fn<(path: string) => Promise<{ distro: string; state: 'stopped' | 'unverifiable' } | null>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('../../hooks', () => ({
  hasHooksFile: mocks.hasHooksFile,
  loadHooks: () => null,
  hasUnrecognizedOrcaYamlKeys: () => false
}))
vi.mock('../../wsl/wsl-unc-access-gate', () => ({ blockedWslDistroForPath: mocks.blocked }))

import { registerWorktreeHookCheckHandler } from './register-worktree-hook-check-handler'

const UNC = String.raw`\\wsl.localhost\Ubuntu\home\u\app`

function check(args: { background?: boolean }) {
  const repo: Partial<Repo> = { id: 'repo', path: UNC, kind: 'git', executionHostId: 'local' }
  const store = { getRepos: () => [repo], getRepo: () => repo }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The handler reads only these store accessors.
  registerWorktreeHookCheckHandler({ store } as never)
  return mocks.handlers.get('hooks:check')!(null, { repoId: 'repo', ...args })
}

describe('hooks:check on a stopped WSL distro', () => {
  beforeEach(() => {
    mocks.hasHooksFile.mockClear()
    mocks.blocked.mockReset()
    mocks.blocked.mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
  })

  it('refuses a background check without opening orca.yaml, so it cannot boot the distro', async () => {
    await expect(check({ background: true })).resolves.toEqual({
      status: 'error',
      hasHooks: false,
      hooks: null,
      mayNeedUpdate: false,
      unavailable: 'wsl-distro-stopped'
    })
    expect(mocks.blocked).toHaveBeenCalledWith(UNC)
    expect(mocks.hasHooksFile).not.toHaveBeenCalled()
  })

  it('marks an unverifiable distro unread, not hook-free, so callers retry instead of storing it', async () => {
    mocks.blocked.mockResolvedValue({ distro: 'Ubuntu', state: 'unverifiable' })

    const result = await check({ background: true })

    expect(result).toMatchObject({ status: 'error', unavailable: 'wsl-distro-unverifiable' })
    expect(mocks.hasHooksFile).not.toHaveBeenCalled()
  })

  it('still reads for a launch, which is a user act that starts the distro anyway', async () => {
    await expect(check({})).resolves.toMatchObject({ status: 'ok' })
    expect(mocks.blocked).not.toHaveBeenCalled()
    expect(mocks.hasHooksFile).toHaveBeenCalledWith(UNC)
  })

  it('reads a running distro for a background check as before', async () => {
    mocks.blocked.mockResolvedValue(null)

    await expect(check({ background: true })).resolves.toMatchObject({ status: 'ok' })
    expect(mocks.hasHooksFile).toHaveBeenCalledWith(UNC)
  })
})
