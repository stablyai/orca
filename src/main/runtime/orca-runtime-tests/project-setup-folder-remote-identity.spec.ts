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
    ['git@gh-personal:me/repo-a.git', 'github:me/repo-a', undefined, null],
    [
      'https://code.corp.example/me/repo-a.git',
      'github:code.corp.example/me/repo-a',
      'code.corp.example',
      undefined
    ]
  ] as const)(
    'keeps a resolved origin nonfork through setup when its local hostname needs resolution: %s',
    async (url, projectId, host, upstream) => {
      const repos: Repo[] = []
      const origin = { owner: 'me', repo: 'repo-a', ...(host ? { host } : {}) }
      parentProbe.mockResolvedValue({ upstream, origin })
      const runtime = createRuntime(repos)
      await withGitFolder({ origin: url }, async (path) => {
        const result = await runtime.setupProjectExistingFolder({
          projectId,
          projectProviderIdentity: { provider: 'github', ...origin },
          hostId: 'runtime:env-1',
          path,
          kind: 'git'
        })
        expect(result.project.id).toBe(projectId)
        expect(result.repo.upstream).toBeNull()
        expect(
          projectHostSetupProjectionFromRepos(JSON.parse(JSON.stringify(repos))).setups[0].projectId
        ).toBe(projectId)
        expect(parentProbe).toHaveBeenCalledTimes(1)
      })
    }
  )

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

it('completes parent-selected setup while unrelated background metadata remains pending', async () => {
  await withGitFolder({ origin: 'https://github.com/me/repo-a.git' }, async (path) => {
    const repos: Repo[] = [
      {
        id: 'blocker',
        path: '/blocked',
        displayName: 'blocker',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'git'
      }
    ]
    const runtime = createRuntime(repos)
    const gate = Promise.withResolvers<forkMetadata.RepoUpstreamProbe>()
    parentProbe
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue({
        upstream: { owner: 'acme', repo: 'repo-a' },
        origin: { owner: 'me', repo: 'repo-a' }
      })
    const background = runtime.repositoryForkBackfill.enqueue(repos)
    try {
      const result = await runtime.setupProjectExistingFolder({
        projectId: 'github:acme/repo-a',
        projectProviderIdentity: repoA,
        hostId: 'runtime:env-1',
        path,
        kind: 'git'
      })
      expect(result.project.id).toBe('github:acme/repo-a')
      expect(repos[0].upstream).toBeUndefined()
      expect(parentProbe).toHaveBeenCalledTimes(2)
    } finally {
      gate.resolve({ upstream: null, origin: null })
      await background
    }
  })
})

it.each([false, true])(
  'refuses changed current origin after an unavailable lookup (pre-existing=%s)',
  async (existing) => {
    await withGitFolder({ origin: 'https://github.com/me/repo-a.git' }, async (path) => {
      const repos: Repo[] = []
      if (existing) {
        repos.push({
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
        })
      }
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
      const rejection = expect(setup).rejects.toThrow(/points at other\/repo-a, not me\/repo-a/)
      await started.promise
      execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/other/repo-a.git'], {
        cwd: path,
        stdio: 'ignore'
      })
      gate.resolve({ upstream: undefined, origin: { owner: 'me', repo: 'repo-a' } })
      await rejection
      expect(repos).toHaveLength(existing ? 1 : 0)
      expect(parentProbe).toHaveBeenCalledTimes(1)
    })
  }
)

it.each([
  [
    'older automatic avatar',
    {
      type: 'image',
      source: 'github',
      src: 'https://ghe.corp.example/old.png?size=64',
      label: 'old/repo-a'
    },
    { host: 'ghe.corp.example', owner: 'new', repo: 'repo-a' }
  ],
  [
    'protected image',
    {
      type: 'image',
      source: 'file',
      src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    },
    null
  ]
] as const)(
  'links a current enterprise remote despite unavailable metadata and a retained %s',
  async (_label, repoIcon, upstream) => {
    await withGitFolder({ origin: 'https://ghe.corp.example/new/repo-a.git' }, async (path) => {
      const repos: Repo[] = [
        {
          id: 'selected',
          path: realpathSync(path),
          displayName: 'repo-a',
          badgeColor: 'blue',
          addedAt: 1,
          kind: 'git',
          executionHostId: 'runtime:env-1',
          gitRemoteIdentity: {
            canonicalKey: 'ghe.corp.example/old/repo-a',
            remoteName: 'origin',
            remoteUrl: 'https://ghe.corp.example/old/repo-a.git'
          },
          repoIcon
        }
      ]
      const runtime = createRuntime(repos)
      const result = await runtime.setupProjectExistingFolder({
        projectId: 'github:ghe.corp.example/new/repo-a',
        projectProviderIdentity: {
          provider: 'github',
          host: 'ghe.corp.example',
          owner: 'new',
          repo: 'repo-a'
        },
        hostId: 'runtime:env-1',
        path,
        kind: 'git'
      })
      expect(result.project.id).toBe('github:ghe.corp.example/new/repo-a')
      expect(repos[0].upstream).toEqual(upstream)
      expect(repos[0].repoIcon).toEqual(repoIcon)
      expect(
        projectHostSetupProjectionFromRepos(JSON.parse(JSON.stringify(repos))).setups[0].projectId
      ).toBe('github:ghe.corp.example/new/repo-a')
    })
  }
)

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

it('publishes metadata retained on a pre-existing row after explicit setup fails', async () => {
  await withGitFolder({ origin: 'https://github.com/me/repo-a.git' }, async (path) => {
    const repos: Repo[] = [
      {
        id: 'selected',
        path: realpathSync(path),
        displayName: 'repo-a',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'git',
        executionHostId: 'runtime:env-1'
      }
    ]
    const runtime = createRuntime(repos)
    parentProbe.mockResolvedValue({
      upstream: { owner: 'acme', repo: 'repo-a' },
      origin: { owner: 'me', repo: 'repo-a' }
    })
    const notifications: string[] = []
    const unsubscribe = runtime.onClientEvent((event) => {
      if (event.type === 'reposChanged') {
        notifications.push(event.type)
      }
    })
    try {
      await expect(
        runtime.setupProjectExistingFolder({
          projectId: 'github:elsewhere/repo-a',
          projectProviderIdentity: { provider: 'github', owner: 'elsewhere', repo: 'repo-a' },
          hostId: 'runtime:env-1',
          path,
          kind: 'git'
        })
      ).rejects.toThrow(/points at me\/repo-a, not elsewhere\/repo-a/)
      expect(repos).toHaveLength(1)
      expect(repos[0].upstream).toEqual({ owner: 'acme', repo: 'repo-a' })
      expect(notifications).toEqual(['reposChanged'])
      expect(parentProbe).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })
})

it.each(['recovered parent', 'unavailable'] as const)(
  'settles an explicit origin after ordinary alias enrichment: %s',
  async (evidence) => {
    await withGitFolder({ origin: 'git@gh-personal:me/repo-a.git' }, async (path) => {
      const repos: Repo[] = []
      const runtime = createRuntime(repos)
      const origin = { owner: 'me', repo: 'repo-a' }
      const ordinary = Promise.withResolvers<forkMetadata.RepoUpstreamProbe>()
      const ordinaryStarted = Promise.withResolvers<void>()
      const ordinaryFinished = Promise.withResolvers<void>()
      const required = Promise.withResolvers<forkMetadata.RepoUpstreamProbe>()
      const requiredStarted = Promise.withResolvers<void>()
      parentProbe
        .mockImplementationOnce(() => {
          ordinaryStarted.resolve()
          return ordinary.promise
        })
        .mockImplementationOnce(() => {
          requiredStarted.resolve()
          return required.promise
        })
      const unsubscribe = runtime.onClientEvent((event) => {
        if (event.type === 'reposChanged' && repos[0]?.repoIcon?.type === 'image') {
          ordinaryFinished.resolve()
        }
      })
      try {
        const added = await runtime.addRepo(path, 'git', 'runtime:env-1')
        await ordinaryStarted.promise
        ordinary.resolve({ upstream: undefined, origin })
        await ordinaryFinished.promise
        expect(added.id).toBe(repos[0].id)
        expect(repos[0].gitRemoteIdentity).toEqual({
          canonicalKey: 'gh-personal/me/repo-a',
          remoteName: 'origin',
          remoteUrl: 'git@gh-personal:me/repo-a.git'
        })
        expect(repos[0].repoIcon).toEqual({
          type: 'image',
          source: 'github',
          src: 'https://github.com/me.png?size=64',
          label: 'me/repo-a'
        })
        expect(repos[0].upstream).toBeUndefined()

        const setup = runtime.setupProjectExistingFolder({
          projectId: 'github:me/repo-a',
          projectProviderIdentity: { provider: 'github', ...origin },
          hostId: 'runtime:env-1',
          path,
          kind: 'git'
        })
        await requiredStarted.promise
        const completion = runtime.repositoryForkBackfill.resolve(repos[0])
        required.resolve({
          upstream: evidence === 'recovered parent' ? { owner: 'acme', repo: 'repo-a' } : undefined,
          origin
        })
        const result = await setup
        await completion
        expect(result.project.id).toBe('github:me/repo-a')
        expect(result.repo.upstream).toEqual(evidence === 'recovered parent' ? origin : null)
        parentProbe.mockResolvedValue({ upstream: { owner: 'acme', repo: 'repo-a' }, origin })
        await runtime.repositoryForkBackfill.run()
        expect(repos[0].upstream).toEqual(evidence === 'recovered parent' ? origin : null)
        expect(
          projectHostSetupProjectionFromRepos(JSON.parse(JSON.stringify(repos))).setups[0].projectId
        ).toBe('github:me/repo-a')
      } finally {
        ordinary.resolve({ upstream: undefined, origin })
        required.resolve({ upstream: undefined, origin })
        unsubscribe()
      }
    })
  }
)

it('accepts remote-less saved-avatar equality without a required probe or new stamp', async () => {
  await withGitFolder({}, async (path) => {
    const repos: Repo[] = [
      {
        id: 'legacy',
        path: realpathSync(path),
        displayName: 'repo-a',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'git',
        executionHostId: 'runtime:env-1',
        repoIcon: {
          type: 'image',
          source: 'github',
          src: 'https://github.com/me.png?size=64',
          label: 'me/repo-a'
        }
      }
    ]
    const runtime = createRuntime(repos)
    const background = Promise.withResolvers<forkMetadata.RepoUpstreamProbe>()
    parentProbe.mockImplementationOnce(() => background.promise)
    try {
      const result = await runtime.setupProjectExistingFolder({
        projectId: 'github:me/repo-a',
        projectProviderIdentity: { provider: 'github', owner: 'me', repo: 'repo-a' },
        hostId: 'runtime:env-1',
        path,
        kind: 'git'
      })
      expect(result.project.id).toBe('github:me/repo-a')
      expect(result.repo.upstream).toBeUndefined()
    } finally {
      const completion = runtime.repositoryForkBackfill.resolve(repos[0])
      background.resolve({ upstream: undefined, origin: null })
      await completion
    }
    expect(repos[0].upstream).toBeUndefined()
  })
})
