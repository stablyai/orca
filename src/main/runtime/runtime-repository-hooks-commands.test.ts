import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { OrcaHooks } from '../../shared/orca-yaml-hook-types'

const mocks = vi.hoisted(() => ({
  blocked: vi.fn(async (): Promise<{ distro: string; state: string } | null> => null),
  hasHooksFile: vi.fn(() => false),
  loadHooks: vi.fn((): OrcaHooks | null => null)
}))

vi.mock('../wsl/wsl-unc-access-gate', () => ({ blockedWslDistroForPath: mocks.blocked }))
vi.mock('../hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasHooksFile: mocks.hasHooksFile,
  loadHooks: mocks.loadHooks
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

// Phones compare this hash with the archive approval desktop records for the trimmed orca.yaml script.
describe('repo.hooks archive trust', () => {
  const localRepo: Repo = { ...repo, path: '/repos/repo' }
  const hooksFor = (hookSettings?: Repo['hookSettings']) =>
    new RuntimeRepositoryHooksCommands({
      resolveRepo: async () => ({ ...localRepo, ...(hookSettings ? { hookSettings } : {}) })
    }).getRepoHooks('repo-1')

  beforeEach(() => {
    mocks.hasHooksFile.mockReturnValue(true)
    mocks.loadHooks.mockReset().mockReturnValue({ scripts: { archive: '  make clean\n' } })
  })

  it('reports the shared archive script in the hash desktop records', async () => {
    await expect(hooksFor()).resolves.toMatchObject({
      archiveTrust: {
        // sha256('make clean'): desktop's hashOrcaHookScript of the trimmed script.
        contentHash: '3eb737ac04c0fa7e0563845bbe946297f97d03f1244d1b4c0fa5496fa4fe9d92',
        scriptContent: 'make clean'
      }
    })
  })

  it('needs no trust for a local-only archive script or a folder, whose removal runs no hook', async () => {
    await expect(
      hooksFor({ mode: 'auto', scripts: { setup: '', archive: 'echo mine' } })
    ).resolves.toMatchObject({ archiveTrust: null })
    await expect(
      new RuntimeRepositoryHooksCommands({
        resolveRepo: async () => ({ ...localRepo, kind: 'folder' })
      }).getRepoHooks('repo-1')
    ).resolves.toMatchObject({ archiveTrust: null })
  })
})
