import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeStore } from './runtime-store-contract'

const PARENT = '/work/platform'
const CHILD = '/work/platform/api'

vi.mock('../git/runner', () => ({ awaitWindowsHostGitEnvironmentReady: vi.fn(async () => {}) }))
vi.mock('../git/repo', () => ({
  isGitRepoAsync: vi.fn(async () => true),
  getRepoName: (path: string) => path.split('/').pop()
}))
vi.mock('../project-groups/nested-repo-discovery', () => ({
  scanNestedRepos: vi.fn(async () => ({ repos: [{ path: CHILD, displayName: 'api', depth: 1 }] }))
}))
vi.mock('../project-groups/nested-repo-import-target', () => ({
  createNestedRepoImportTargetResolver: () => ({ resolveLocal: async (path: string) => path })
}))

const { RuntimeNestedRepoImport } = await import('./runtime-nested-repo-import')

function row(id: string, host: Pick<Repo, 'connectionId' | 'executionHostId'>): Repo {
  return { id, path: CHILD, displayName: 'api', badgeColor: '#000', addedAt: 1, ...host }
}

function createImporter(repos: Repo[]) {
  const moveProjectToGroup = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub covers every store call the import makes.
  const store = {
    getRepos: () => repos,
    addRepo: (repo: Repo) => repos.push(repo),
    createProjectGroup: (input: { name: string }) => ({ id: 'group-1', ...input }),
    moveProjectToGroup
  } as unknown as RuntimeStore
  const importer = new RuntimeNestedRepoImport({
    getStore: () => store,
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyReposChanged: vi.fn()
  })
  const run = () =>
    importer.import({
      parentPath: PARENT,
      groupName: 'Platform',
      projectPaths: [CHILD],
      mode: 'group'
    })
  return { run, moveProjectToGroup }
}

describe('runtime nested repo import with an SSH row at the same path', () => {
  it('imports the local repo and leaves the SSH row out of the new local group', async () => {
    const repos = [row('ssh-api', { connectionId: 'ssh-1' })]
    const { run, moveProjectToGroup } = createImporter(repos)

    const result = await run()

    expect(moveProjectToGroup).not.toHaveBeenCalled()
    expect(result.projects).toEqual([expect.objectContaining({ path: CHILD, status: 'imported' })])
    expect(repos.map((repo) => repo.connectionId ?? 'local')).toEqual(['ssh-1', 'local'])
  })

  it('groups a paired host runtime-stamped native row instead of importing it twice', async () => {
    const native = row('native-api', { executionHostId: 'runtime:env-1' })
    const repos = [native]
    const { run, moveProjectToGroup } = createImporter(repos)

    const result = await run()

    expect(moveProjectToGroup).toHaveBeenCalledWith(native, 'group-1', 0)
    expect(result.projects).toEqual([
      expect.objectContaining({ projectId: 'native-api', status: 'already-known' })
    ])
    expect(repos).toHaveLength(1)
  })
})
