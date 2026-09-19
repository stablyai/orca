import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getDefaultWorkspaceDir } from '../../shared/constants'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeStore } from './runtime-store-contract'
import { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'

const repoAt = (path: string): Repo => ({
  id: `repo-${path}`,
  path,
  displayName: path.split('/').pop() ?? path,
  badgeColor: '#aabbcc',
  addedAt: 0,
  kind: 'git'
})

// Minimal RuntimeStore: `create` reads repos and settings only until the target
// directory work begins, and every test below returns from the dedup check.
const makeStore = (repos: Repo[], workspaceDir: string): RuntimeStore => ({
  getRepos: () => repos,
  getRepo: () => undefined,
  addRepo: () => {},
  updateRepo: () => undefined,
  getAllWorktreeMeta: () => [],
  getWorktreeMeta: () => null,
  setWorktreeMeta: () => {},
  removeWorktreeMeta: () => {},
  getSettings: () => ({
    workspaceDir,
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: '',
    branchPrefixCustom: ''
  })
})

const makeController = (
  repos: Repo[],
  workspaceDir: string
): RuntimeRepositoryRegistrationController =>
  new RuntimeRepositoryRegistrationController({
    getStore: () => makeStore(repos, workspaceDir),
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {}
  })

describe('RuntimeRepositoryRegistrationController default create parent', () => {
  // Each case proves the resolved parent through the dedup-by-target-path hit:
  // `create` returns the existing row only when parent + name match its path.

  it('uses a workspace directory the user actually chose when parentPath is absent', async () => {
    const existing = repoAt('/srv/chosen/new-app')
    const controller = makeController([existing], '/srv/chosen')

    await expect(controller.create(undefined, 'new-app', 'git')).resolves.toEqual({
      repo: existing
    })
  })

  it('treats a blank parentPath as absent', async () => {
    const existing = repoAt('/srv/chosen/new-app')
    const controller = makeController([existing], '/srv/chosen')

    await expect(controller.create('   ', 'new-app', 'git')).resolves.toEqual({
      repo: existing
    })
  })

  it('ignores the untouched seeded default and falls back to the home projects directory', async () => {
    const existing = repoAt(join(homedir(), 'orca', 'projects', 'new-app'))
    const controller = makeController([existing], getDefaultWorkspaceDir(homedir()))

    await expect(controller.create(undefined, 'new-app', 'git')).resolves.toEqual({
      repo: existing
    })
  })

  it('honors an explicit parent over the default', async () => {
    const defaultRow = repoAt(join(homedir(), 'orca', 'projects', 'new-app'))
    const explicitRow = repoAt('/srv/custom/new-app')
    const controller = makeController([defaultRow, explicitRow], getDefaultWorkspaceDir(homedir()))

    await expect(controller.create('/srv/custom', 'new-app', 'git')).resolves.toEqual({
      repo: explicitRow
    })
  })

  it('still rejects a non-absolute parent', async () => {
    const controller = makeController([], '/srv/chosen')

    await expect(controller.create('relative/path', 'new-app', 'git')).resolves.toEqual({
      error: 'Parent directory must be an absolute path'
    })
  })
})
