import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type * as WslUncAccessGateModule from '../wsl/wsl-unc-access-gate'
import type { RuntimeStore } from './runtime-store-contract'

const mocks = vi.hoisted(() => ({
  stopped: true,
  getRepoUpstream: vi.fn(),
  blockedWslDistroForPath: vi.fn()
}))
vi.mock('../github/client', () => ({ getRepoUpstream: mocks.getRepoUpstream }))
vi.mock('../repo-icon-autodetect', () => ({ detectGitHubAvatarIcon: vi.fn() }))
vi.mock('../wsl/wsl-unc-access-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof WslUncAccessGateModule>()),
  blockedWslDistroForPath: mocks.blockedWslDistroForPath,
  wslDistroForPath: (path: string) => (path.startsWith('\\\\wsl.localhost\\') ? 'Ubuntu' : null)
}))

import { RuntimeRepositoryForkBackfill } from './runtime-repository-fork-backfill'

function backfillFor(path: string) {
  const repo: Repo = {
    id: 'r',
    path,
    displayName: 'r',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git'
  }
  const updateRepo = vi.fn()
  const store = { getRepos: () => [repo], updateRepo }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: run() reads only getRepos and updateRepo.
  const runtimeStore = store as unknown as RuntimeStore
  const backfill = new RuntimeRepositoryForkBackfill(
    () => runtimeStore,
    () => {}
  )
  return { backfill, updateRepo }
}

describe('startup upstream backfill for a stopped WSL distro (E9)', () => {
  it('runs no gh or Git while stopped and leaves upstream unset for the next startup', async () => {
    mocks.blockedWslDistroForPath.mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
    const { backfill, updateRepo } = backfillFor('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')
    await backfill.run()
    expect(mocks.getRepoUpstream).not.toHaveBeenCalled()
    expect(updateRepo).not.toHaveBeenCalled()
  })

  it('backfills a running distro and a host repo exactly as before', async () => {
    mocks.blockedWslDistroForPath.mockResolvedValue(null)
    mocks.getRepoUpstream.mockResolvedValue(null)
    for (const path of ['\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', 'C:/repos/one']) {
      const { backfill, updateRepo } = backfillFor(path)
      await backfill.run()
      expect(updateRepo).toHaveBeenCalledWith(expect.objectContaining({ path }), {
        upstream: null
      })
    }
    expect(mocks.getRepoUpstream).toHaveBeenCalledTimes(2)
  })
})
