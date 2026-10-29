import { realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  OrcaRuntimeService,
  execFileSync,
  getRepoUpstreamMock,
  join,
  mkdtemp,
  projectHostSetupProjectionFromRepos,
  rm,
  tmpdir
} from '../orca-runtime-test-mocks.spec'
import { store } from '../orca-runtime-test-fixtures.spec'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeStore } from '../runtime-store-contract'

function createRuntime(repos: Repo[]): OrcaRuntimeService {
  const runtimeStore: RuntimeStore = {
    ...store,
    getRepos: () => [...repos],
    addRepo: (repo: Repo) => {
      repos.push(repo)
    },
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    updateRepo: ({ id }, updates) => {
      const repo = repos.find((entry) => entry.id === id)
      if (!repo) {
        return null
      }
      Object.assign(repo, updates)
      return { ...repo }
    },
    removeProjectForHost: ({ id }: { id: string }) => {
      const index = repos.findIndex((repo) => repo.id === id)
      if (index !== -1) {
        repos.splice(index, 1)
      }
    },
    getProjects: () => [...projectHostSetupProjectionFromRepos(repos).projects],
    getProjectHostSetups: () => [...projectHostSetupProjectionFromRepos(repos).setups]
  }
  return new OrcaRuntimeService(runtimeStore)
}

async function withGitFolder(
  remotes: Record<string, string>,
  run: (path: string) => Promise<void>
): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-remote-'))
  try {
    execFileSync('git', ['init'], { cwd: tempRoot, stdio: 'ignore' })
    for (const [name, url] of Object.entries(remotes)) {
      execFileSync('git', ['remote', 'add', name, url], { cwd: tempRoot, stdio: 'ignore' })
    }
    await run(tempRoot)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

const repoA = { provider: 'github' as const, owner: 'acme', repo: 'repo-a' }

describe('OrcaRuntimeService project setup of an existing folder (#30663)', () => {
  it('refuses to relabel a folder whose own GitHub remote names another repository', async () => {
    const repos: Repo[] = []
    getRepoUpstreamMock.mockResolvedValueOnce(null)
    const runtime = createRuntime(repos)

    await withGitFolder({ origin: 'https://github.com/acme/repo-b.git' }, async (path) => {
      await expect(
        runtime.setupProjectExistingFolder({
          projectId: 'github:acme/repo-a',
          projectProviderIdentity: repoA,
          hostId: 'runtime:env-1',
          path,
          kind: 'git'
        })
      ).rejects.toThrow(/points at acme\/repo-b, not acme\/repo-a/)
    })

    expect(repos).toHaveLength(0)
  })

  it('links a fork whose upstream remote names the project', async () => {
    const repos: Repo[] = []
    getRepoUpstreamMock.mockResolvedValueOnce(null)
    const runtime = createRuntime(repos)

    await withGitFolder(
      {
        origin: 'https://github.com/me/repo-a-fork.git',
        upstream: 'https://github.com/acme/repo-a.git'
      },
      async (path) => {
        const result = await runtime.setupProjectExistingFolder({
          projectId: 'github:acme/repo-a',
          projectProviderIdentity: repoA,
          hostId: 'runtime:env-1',
          path,
          kind: 'git'
        })
        expect(result.project.id).toBe('github:acme/repo-a')
      }
    )
  })

  it('still links a folder whose remote is not on GitHub', async () => {
    const repos: Repo[] = []
    getRepoUpstreamMock.mockResolvedValueOnce(null)
    const runtime = createRuntime(repos)

    await withGitFolder({ origin: 'https://gitlab.example.test/acme/repo-a.git' }, async (path) => {
      const result = await runtime.setupProjectExistingFolder({
        projectId: 'github:acme/repo-a',
        projectProviderIdentity: repoA,
        hostId: 'runtime:env-1',
        path,
        kind: 'git'
      })
      expect(result.project.id).toBe('github:acme/repo-a')
      expect(repos[0]?.upstream).toEqual({ owner: 'acme', repo: 'repo-a' })
    })
  })

  it('links a folder whose remote host is an SSH alias for the project repository', async () => {
    const repos: Repo[] = []
    getRepoUpstreamMock.mockResolvedValueOnce(null)
    const runtime = createRuntime(repos)

    await withGitFolder({ origin: 'git@github-work:acme/repo-a.git' }, async (path) => {
      const result = await runtime.setupProjectExistingFolder({
        projectId: 'github:acme/repo-a',
        projectProviderIdentity: repoA,
        hostId: 'runtime:env-1',
        path,
        kind: 'git'
      })
      expect(result.project.id).toBe('github:acme/repo-a')
    })
  })

  it('judges an already-registered folder by its current remotes, not the stored ones', async () => {
    const repos: Repo[] = []
    const runtime = createRuntime(repos)

    await withGitFolder(
      {
        origin: 'https://github.com/me/repo-a-fork.git',
        upstream: 'https://github.com/acme/repo-a.git'
      },
      async (path) => {
        // Registered before the user added the `upstream` remote the refusal recommends.
        repos.push({
          id: 'repo-registered',
          path: realpathSync(path),
          displayName: 'repo-a-fork',
          badgeColor: '#000000',
          addedAt: 1,
          kind: 'git',
          executionHostId: 'runtime:env-1',
          upstream: null,
          gitRemoteIdentity: {
            canonicalKey: 'github.com/me/repo-a-fork',
            remoteName: 'origin',
            remoteUrl: 'https://github.com/me/repo-a-fork.git'
          }
        })
        const result = await runtime.setupProjectExistingFolder({
          projectId: 'github:acme/repo-a',
          projectProviderIdentity: repoA,
          hostId: 'runtime:env-1',
          path,
          kind: 'git'
        })
        expect(result.project.id).toBe('github:acme/repo-a')
        expect(result.repo.id).toBe('repo-registered')
      }
    )
  })
})
