import { realpathSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { execFileSync } from 'node:child_process'
import * as forkMetadata from '../../github/client/fetch/repo-slug-upstream'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project/host-setup/project-host-setup-projection'
import { tmpdir } from 'node:os'
import { store } from '../construction/test-context/orca-runtime-test-fixtures.spec'
import type { Repo } from '../../../shared/repository/repo-types'
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

it('retains matching null authority when a nonfork result settles during setup', async () => {
  await withGitFolder({ origin: 'https://github.com/me/repo-a.git' }, async (path) => {
    const repos: Repo[] = []
    const runtime = createRuntime(repos)
    const gate = Promise.withResolvers<forkMetadata.RepoUpstreamProbe>()
    const started = Promise.withResolvers<void>()
    parentProbe.mockImplementationOnce(() => {
      started.resolve()
      return gate.promise
    })
    const setup = runtime.setupProjectExistingFolder({
      projectId: 'github:me/repo-a',
      projectProviderIdentity: { provider: 'github', owner: 'me', repo: 'repo-a' },
      hostId: 'runtime:env-1',
      path,
      kind: 'git'
    })
    await started.promise
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/other/repo-a.git'], {
      cwd: path,
      stdio: 'ignore'
    })
    gate.resolve({ upstream: null, origin: { owner: 'me', repo: 'repo-a' } })
    const result = await setup
    expect(result.project.id).toBe('github:me/repo-a')
    expect(result.repo.upstream).toBeNull()
    expect(
      projectHostSetupProjectionFromRepos(JSON.parse(JSON.stringify(repos))).setups[0].projectId
    ).toBe('github:me/repo-a')
  })
})
