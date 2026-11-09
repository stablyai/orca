import { realpathSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { execFileSync } from 'node:child_process'
import * as forkMetadata from '../../github/client/fetch/repo-slug-upstream'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { tmpdir } from 'node:os'
import { store } from './orca-runtime-test-fixtures.spec'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeStore } from '../construction/runtime-store-contract'

const parentProbe = vi.spyOn(forkMetadata, 'probeRepoUpstream')
beforeEach(() => {
  parentProbe.mockReset().mockResolvedValue({ upstream: undefined, origin: null })
})

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

describe('explicit fork project setup with deferred ordinary metadata', () => {
  it.each([
    ['github:acme/repo-a', { owner: 'acme', repo: 'repo-a' }],
    ['github:me/repo-a', { owner: 'me', repo: 'repo-a' }]
  ] as const)(
    'preserves selected project %s when a hosted parent is known',
    async (projectId, upstream) => {
      const repos: Repo[] = []
      parentProbe.mockResolvedValue({
        upstream: { owner: 'acme', repo: 'repo-a' },
        origin: { owner: 'me', repo: 'repo-a' }
      })
      const runtime = createRuntime(repos)
      await withGitFolder({ origin: 'https://github.com/me/repo-a.git' }, async (path) => {
        const result = await runtime.setupProjectExistingFolder({
          projectId,
          projectProviderIdentity: { provider: 'github', ...upstream },
          hostId: 'runtime:env-1',
          path,
          kind: 'git'
        })
        expect(result.project.id).toBe(projectId)
        expect(result.repo.upstream).toEqual(upstream)
        expect(
          projectHostSetupProjectionFromRepos(JSON.parse(JSON.stringify(repos))).setups[0].projectId
        ).toBe(projectId)
        expect(parentProbe).toHaveBeenCalledTimes(1)
      })
    }
  )

  it.each([null, undefined])(
    'keeps a matching origin nonfork when parent evidence is %s',
    async (upstream) => {
      const repos: Repo[] = []
      parentProbe.mockResolvedValue({ upstream, origin: { owner: 'me', repo: 'repo-a' } })
      const runtime = createRuntime(repos)
      await withGitFolder({ origin: 'https://github.com/me/repo-a.git' }, async (path) => {
        const result = await runtime.setupProjectExistingFolder({
          projectId: 'github:me/repo-a',
          projectProviderIdentity: { provider: 'github', owner: 'me', repo: 'repo-a' },
          hostId: 'runtime:env-1',
          path,
          kind: 'git'
        })
        expect(result.project.id).toBe('github:me/repo-a')
        expect(result.repo.upstream).toBeNull()
        expect(
          projectHostSetupProjectionFromRepos(JSON.parse(JSON.stringify(repos))).setups[0].projectId
        ).toBe('github:me/repo-a')
        expect(parentProbe).toHaveBeenCalledTimes(1)
        const again = await runtime.setupProjectExistingFolder({
          projectId: 'github:me/repo-a',
          projectProviderIdentity: { provider: 'github', owner: 'me', repo: 'repo-a' },
          hostId: 'runtime:env-1',
          path,
          kind: 'git'
        })
        expect(again.repo.upstream).toBeNull()
        expect(parentProbe).toHaveBeenCalledTimes(1)
      })
    }
  )
})

it('keeps an explicit origin choice after its queued shared result arrives late', async () => {
  await withGitFolder({ origin: 'https://github.com/me/repo-a.git' }, async (path) => {
    vi.useFakeTimers()
    const selected: Repo = {
      id: 'selected',
      path: realpathSync(path),
      displayName: 'repo-a',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'git',
      executionHostId: 'runtime:env-1',
      gitRemoteIdentity: {
        canonicalKey: 'github.com/me/repo-a',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/me/repo-a.git'
      }
    }
    const blocker: Repo = { ...selected, id: 'blocker', path: '/blocked' }
    const repos = [blocker, selected]
    const runtime = createRuntime(repos)
    const gate = Promise.withResolvers<forkMetadata.RepoUpstreamProbe>()
    const queued = Promise.withResolvers<void>()
    parentProbe
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue({
        upstream: { owner: 'acme', repo: 'repo-a' },
        origin: { owner: 'me', repo: 'repo-a' }
      })
    void runtime.repositoryForkBackfill.enqueue(repos)
    const resolveMetadata = runtime.repositoryForkBackfill.resolve.bind(
      runtime.repositoryForkBackfill
    )
    vi.spyOn(runtime.repositoryForkBackfill, 'resolve').mockImplementation((repo) => {
      const result = resolveMetadata(repo)
      queued.resolve()
      return result
    })
    try {
      const setup = runtime.setupProjectExistingFolder({
        projectId: 'github:me/repo-a',
        projectProviderIdentity: { provider: 'github', owner: 'me', repo: 'repo-a' },
        hostId: 'runtime:env-1',
        path,
        kind: 'git'
      })
      await queued.promise
      await vi.advanceTimersByTimeAsync(10_000)
      expect((await setup).repo.upstream).toBeNull()
      gate.resolve({ upstream: null, origin: null })
      await vi.waitFor(() =>
        expect(repos[1].repoIcon).toEqual({
          type: 'image',
          src: 'https://github.com/me.png?size=64',
          source: 'github',
          label: 'me/repo-a'
        })
      )
      expect(repos[1].upstream).toBeNull()
      expect(
        projectHostSetupProjectionFromRepos(JSON.parse(JSON.stringify(repos))).setups[1].projectId
      ).toBe('github:me/repo-a')
      expect(parentProbe).toHaveBeenCalledTimes(2)
    } finally {
      gate.resolve({ upstream: null, origin: null })
      vi.useRealTimers()
    }
  })
})
