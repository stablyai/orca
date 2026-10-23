import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import type { Repo } from '../../shared/repo-types'
import { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'

const PROJECT_ID = 'git:gitlab.com/group/app'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A real checkout whose origin is `remoteUrl`, registered with no remote probed yet. */
async function clonedRepo(remoteUrl: string): Promise<Repo> {
  const path = await mkdtemp(join(tmpdir(), 'orca-git-remote-link-'))
  roots.push(path)
  execFileSync('git', ['init', '-q'], { cwd: path })
  execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: path })
  return { id: 'cloned', path, displayName: 'app', badgeColor: 'blue', addedAt: 1, kind: 'git' }
}

function makeController(cloned: Repo) {
  const repos: Repo[] = []
  const store = {
    getProjects: () => projectHostSetupProjectionFromRepos(repos).projects,
    getProjectHostSetups: () => projectHostSetupProjectionFromRepos(repos).setups,
    updateRepo: ({ id }: Pick<Repo, 'id'>, updates: Partial<Repo>) => {
      const index = repos.findIndex((entry) => entry.id === id)
      if (index === -1) {
        return null
      }
      repos[index] = { ...repos[index], ...updates }
      return repos[index]
    },
    removeProjectForHost: (id: string) => {
      repos.splice(
        repos.findIndex((entry) => entry.id === id),
        1
      )
    }
  }
  const controller = new RuntimeProjectHostSetupController({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller's clone and link paths read only these store members.
    getStore: () => store as never,
    listRepos: () => repos,
    addRepo: vi.fn(),
    cloneRepo: vi.fn(async () => {
      repos.push(cloned)
      return cloned
    }),
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyReposChanged: vi.fn(),
    countLiveTerminalsForRepo: () => 0
  })
  return { controller, repos }
}

describe('RuntimeProjectHostSetupController with a Git-remote project', () => {
  it.each(['https://gitlab.com/group/app.git', 'git@gitlab.com:group/app.git'])(
    'links a fresh clone of %s into the requested project',
    async (remoteUrl) => {
      const { controller } = makeController(await clonedRepo(remoteUrl))
      const result = await controller.setupClone({
        projectId: PROJECT_ID,
        hostId: 'runtime:env-1',
        url: remoteUrl,
        destination: '/tmp'
      })
      expect(result.project.id).toBe(PROJECT_ID)
      expect(result.setup).toMatchObject({ projectId: PROJECT_ID, setupMethod: 'cloned' })
      expect(result.repo.gitRemoteIdentity?.remoteUrl).toBe(remoteUrl)
    }
  )

  it('rolls back a clone whose remote names another repository', async () => {
    const { controller, repos } = makeController(
      await clonedRepo('https://gitlab.com/group/other.git')
    )
    await expect(
      controller.setupClone({
        projectId: PROJECT_ID,
        hostId: 'runtime:env-1',
        url: 'https://gitlab.com/group/other.git',
        destination: '/tmp'
      })
    ).rejects.toThrow('Imported folder does not match the selected project identity.')
    expect(repos).toHaveLength(0)
  })
})
