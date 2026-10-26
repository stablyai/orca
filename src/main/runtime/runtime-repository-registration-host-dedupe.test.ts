import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'
import type { RuntimeStore } from './runtime-store-contract'

vi.mock('../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn().mockResolvedValue({})
}))
vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))

function createController(seed: Repo[]): {
  controller: RuntimeRepositoryRegistrationController
  repos: Repo[]
} {
  const repos = [...seed]
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    addRepo: (repo: Repo) => {
      repos.push(repo)
      return repo
    },
    updateRepo: () => null
  }
  const controller = new RuntimeRepositoryRegistrationController({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: add()/create() only use getRepos/getRepo/addRepo/updateRepo.
    getStore: () => store as unknown as RuntimeStore,
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {}
  })
  return { controller, repos }
}

function remoteRow(path: string, fields: Pick<Repo, 'connectionId' | 'executionHostId'>): Repo {
  return {
    id: 'ssh-row',
    path,
    displayName: 'remote',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'folder',
    ...fields
  }
}

// Why the third: a runtime host's nested SSH target appears only in `connectionId`.
const SSH_SPELLINGS = [
  ['executionHostId', { executionHostId: 'ssh:gpu' as const }],
  ['legacy connectionId', { connectionId: 'gpu' }],
  ['nested SSH on a runtime host', { executionHostId: 'runtime:env' as const, connectionId: 'gpu' }]
] as const

describe('project registration dedupes only against rows on the same host', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-runtime-host-dedupe-')))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.each(SSH_SPELLINGS)(
    'create makes a local project where an SSH project uses the same path (%s)',
    async (_label, fields) => {
      const targetPath = join(root, 'notes')
      const { controller, repos } = createController([remoteRow(targetPath, fields)])

      const result = await controller.create(root, 'notes', 'folder')

      if (!('repo' in result)) {
        throw new Error(result.error)
      }
      expect(result.repo.id).not.toBe('ssh-row')
      expect(result.repo.path).toBe(targetPath)
      expect(repos).toHaveLength(2)
      expect((await stat(targetPath)).isDirectory()).toBe(true)
    }
  )

  it('create still returns the local project already at that path', async () => {
    const targetPath = join(root, 'notes')
    await mkdir(targetPath)
    const local: Repo = { ...remoteRow(targetPath, {}), id: 'local-row' }
    const { controller, repos } = createController([local])

    const result = await controller.create(root, 'notes', 'folder')

    if (!('repo' in result)) {
      throw new Error(result.error)
    }
    expect(result.repo.id).toBe('local-row')
    expect(repos).toHaveLength(1)
  })

  it.each(SSH_SPELLINGS)(
    'add registers a local folder where an SSH project uses the same path (%s)',
    async (_label, fields) => {
      const folderPath = join(root, 'notes')
      await mkdir(folderPath)
      const { controller, repos } = createController([remoteRow(folderPath, fields)])

      const added = await controller.add(folderPath, 'folder')

      expect(added.id).not.toBe('ssh-row')
      expect(repos).toHaveLength(2)
    }
  )

  it("add for a runtime host skips that host's nested SSH project at the same path", async () => {
    const folderPath = join(root, 'notes')
    await mkdir(folderPath)
    const nested = remoteRow(folderPath, { executionHostId: 'runtime:env', connectionId: 'gpu' })
    const { controller, repos } = createController([nested])

    const added = await controller.add(folderPath, 'folder', 'runtime:env')

    expect(added.id).not.toBe('ssh-row')
    expect(repos).toHaveLength(2)
  })

  it('add for a runtime host still returns its own project at the same path', async () => {
    const folderPath = join(root, 'notes')
    await mkdir(folderPath)
    const own: Repo = { ...remoteRow(folderPath, { executionHostId: 'runtime:env' }), id: 'own' }
    const { controller, repos } = createController([own])

    const added = await controller.add(folderPath, 'folder', 'runtime:env')

    expect(added.id).toBe('own')
    expect(repos).toHaveLength(1)
  })
})
