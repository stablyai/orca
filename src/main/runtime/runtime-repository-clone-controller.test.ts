import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as GitRunner from '../git/runner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { detectRepoIconAndUpstream } from '../repo-icon-autodetect'
import { RuntimeRepositoryCloneController } from './runtime-repository-clone-controller'
import type { RuntimeStore } from './runtime-store-contract'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  gitSpawnAfterWindowsEnvironmentReady: spawnMock
}))
vi.mock('../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn().mockResolvedValue({})
}))
vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))

const url = 'https://example.com/orca.git'

function createController(): { controller: RuntimeRepositoryCloneController; repos: Repo[] } {
  const repos: Repo[] = []
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    addRepo: (repo: Repo) => {
      repos.push(repo)
      return repo
    },
    updateRepo: () => null,
    getAllWorktreeMeta: () => ({})
  }
  const controller = new RuntimeRepositoryCloneController({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: clone() only uses the store members defined above.
    getStore: () => store as unknown as RuntimeStore,
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {}
  })
  return { controller, repos }
}

describe('RuntimeRepositoryCloneController new Git repository observer', () => {
  let destination: string

  beforeEach(async () => {
    destination = await realpath(await mkdtemp(join(tmpdir(), 'orca-runtime-clone-')))
    vi.mocked(detectRepoIconAndUpstream).mockReset().mockResolvedValue({})
    spawnMock.mockReset().mockImplementation(async () => {
      const proc = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
      setImmediate(() => proc.emit('close', 0, null))
      return proc
    })
  })

  afterEach(async () => {
    await rm(destination, { recursive: true, force: true })
  })

  it('reports a fresh clone once, with its host stamp and clone path', async () => {
    const { controller, repos } = createController()
    const observer = vi.fn()

    const cloned = await controller.clone(url, destination, 'runtime:env-1', observer)

    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith(repos[0])
    expect(cloned).toMatchObject({ id: repos[0].id, executionHostId: 'runtime:env-1' })
    expect(repos[0].path).toBe(join(destination, 'orca'))
  })

  it('reports nothing when another registration lands during icon discovery', async () => {
    const { controller, repos } = createController()
    const observer = vi.fn()
    vi.mocked(detectRepoIconAndUpstream).mockImplementationOnce(async () => {
      repos.push({
        id: 'competitor',
        path: join(destination, 'orca'),
        displayName: 'orca',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'git'
      })
      return {}
    })

    const cloned = await controller.clone(url, destination, null, observer)

    expect(cloned.id).toBe('competitor')
    expect(repos).toHaveLength(1)
    expect(observer).not.toHaveBeenCalled()
  })

  it('does not report the same path stamped for a different runtime host as reused', async () => {
    const { controller, repos } = createController()
    const first = vi.fn()
    const second = vi.fn()
    await controller.clone(url, destination, 'runtime:env-1', first)
    // A second host's row at the same path is not this call's winner.
    repos[0] = { ...repos[0], executionHostId: 'runtime:env-2' }

    await controller.clone(url, destination, 'runtime:env-1', second)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(repos).toHaveLength(2)
  })
})
