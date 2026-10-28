import { runProcessSync } from '@orca/process-host'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { RuntimeRepositoryCloneController } from './runtime-repository-clone-controller'
import type { RuntimeStore } from './runtime-store-contract'

vi.mock('../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn().mockResolvedValue({})
}))
vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))

function runGit(args: string[]): void {
  const result = runProcessSync({ program: 'git', args })
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

function createController(seed: Repo[]): {
  controller: RuntimeRepositoryCloneController
  repos: Repo[]
} {
  const repos = [...seed]
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getAllWorktreeMeta: () => ({}),
    addRepo: (repo: Repo) => {
      repos.push(repo)
      return repo
    },
    updateRepo: (target: Repo, updates: Partial<Repo>) => Object.assign(target, updates)
  }
  const controller = new RuntimeRepositoryCloneController({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: clone() only uses the methods above.
    getStore: () => store as unknown as RuntimeStore,
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {}
  })
  return { controller, repos }
}

function folderRow(path: string, fields: Pick<Repo, 'connectionId' | 'executionHostId'>): Repo {
  return {
    id: 'existing-row',
    path,
    displayName: 'source',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'folder',
    ...fields
  }
}

describe('clone reuses only a project on this machine', () => {
  let root: string
  let sourceUrl: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-clone-host-dedupe-')))
    const source = join(root, 'origin', 'source')
    runGit(['init', '-q', source])
    runGit([
      '-C',
      source,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init'
    ])
    sourceUrl = pathToFileURL(source).href
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it.each([
    ['executionHostId', { executionHostId: 'ssh:gpu' as const }],
    ['legacy connectionId', { connectionId: 'gpu' }],
    [
      'nested SSH on a runtime host',
      { executionHostId: 'runtime:env' as const, connectionId: 'gpu' }
    ]
  ])(
    'adds a new project where an SSH folder project uses the path (%s)',
    async (_label, fields) => {
      const destination = join(root, 'dest')
      const remote = folderRow(join(destination, 'source'), fields)
      const { controller, repos } = createController([remote])

      const cloned = await controller.clone(sourceUrl, destination)

      expect(cloned.id).not.toBe('existing-row')
      expect(repos).toHaveLength(2)
      expect(remote.kind).toBe('folder')
    }
  )

  it('converts the local folder project already at the clone path', async () => {
    const destination = join(root, 'dest')
    const { controller, repos } = createController([folderRow(join(destination, 'source'), {})])

    const cloned = await controller.clone(sourceUrl, destination)

    expect(cloned.id).toBe('existing-row')
    expect(repos).toHaveLength(1)
  })
})
