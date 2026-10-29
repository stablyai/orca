import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  blocked: vi.fn(async (): Promise<{ distro: string; state: string } | null> => null),
  hasHooksFile: vi.fn(() => false)
}))

vi.mock('../wsl/wsl-unc-access-gate', () => ({ blockedWslDistroForPath: mocks.blocked }))
vi.mock('../hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasHooksFile: mocks.hasHooksFile
}))

import { RuntimeRepositoryHooksCommands } from './runtime-repository-hooks-commands'

const repo: Repo = {
  id: 'repo-1',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}
const commands = new RuntimeRepositoryHooksCommands({ resolveRepo: async () => repo })

beforeEach(() => {
  mocks.blocked.mockReset().mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
  mocks.hasHooksFile.mockReset().mockReturnValue(false)
})

// The host's own check of a WSL repo: orca.yaml over UNC would start a stopped distro (E9).
describe('repo.hooksCheck on the host', () => {
  it('a background check of a stopped distro reads no file and says why', async () => {
    await expect(commands.checkRepoHooks('repo-1', { background: true })).resolves.toMatchObject({
      status: 'error',
      hasHooks: false,
      unavailable: 'wsl-distro-stopped'
    })
    expect(mocks.blocked).toHaveBeenCalledWith(repo.path)
    expect(mocks.hasHooksFile).not.toHaveBeenCalled()
  })

  it('an unverifiable distro is refused too, as worth a retry', async () => {
    mocks.blocked.mockResolvedValue({ distro: 'Ubuntu', state: 'unverifiable' })
    await expect(commands.checkRepoHooks('repo-1', { background: true })).resolves.toMatchObject({
      unavailable: 'wsl-distro-unverifiable'
    })
  })

  it('a user-asked check, or one from an older client, reads as before', async () => {
    await expect(commands.checkRepoHooks('repo-1')).resolves.toMatchObject({ status: 'ok' })
    expect(mocks.blocked).not.toHaveBeenCalled()
    expect(mocks.hasHooksFile).toHaveBeenCalledWith(repo.path)
  })
})
