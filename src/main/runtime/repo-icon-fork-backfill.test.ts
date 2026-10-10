import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import * as client from '../github/client'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../github/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRepoUpstream: vi.fn(),
  getRepoSlug: vi.fn()
}))

const getRepoUpstream = vi.mocked(client.getRepoUpstream)
const getRepoSlug = vi.mocked(client.getRepoSlug)

type BackfillInternals = { repositoryForkBackfill: { run(): Promise<void> } }

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/rocket-pro',
    displayName: 'rocket-pro',
    badgeColor: '#2563eb',
    addedAt: 1,
    kind: 'git',
    repoIcon: {
      type: 'image',
      src: 'https://github.com/acme.png?size=64',
      source: 'github',
      label: 'acme/rocket-pro'
    },
    ...overrides
  }
}

function attachStore(runtime: OrcaRuntimeService, repos: Repo[]) {
  const updateRepo = vi.fn((repoId: string, updates: Partial<Repo>) => {
    const index = repos.findIndex((repo) => repo.id === repoId)
    repos[index] = { ...repos[index], ...updates }
  })
  Object.assign(runtime, { store: { getRepos: () => repos, updateRepo } })
  return updateRepo
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('startup fork-upstream backfill', () => {
  it('keeps a renamed fork own owner avatar while recording the upstream', async () => {
    const runtime = new OrcaRuntimeService()
    const updateRepo = attachStore(runtime, [makeRepo()])
    getRepoUpstream.mockResolvedValue({ owner: 'upstream-org', repo: 'rocket' })
    getRepoSlug.mockResolvedValue({ owner: 'acme', repo: 'rocket-pro' })

    await (runtime as unknown as BackfillInternals).repositoryForkBackfill.run()

    expect(updateRepo).toHaveBeenCalledExactlyOnceWith('repo-1', {
      upstream: { owner: 'upstream-org', repo: 'rocket' },
      repoIcon: {
        type: 'image',
        src: 'https://github.com/acme.png?size=64',
        source: 'github',
        label: 'acme/rocket-pro'
      }
    })
  })

  it('migrates a same-name fork to the upstream owner avatar', async () => {
    const runtime = new OrcaRuntimeService()
    const updateRepo = attachStore(runtime, [
      makeRepo({
        path: '/workspace/rocket',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/acme.png?size=64',
          source: 'github',
          label: 'acme/rocket'
        }
      })
    ])
    getRepoUpstream.mockResolvedValue({ owner: 'upstream-org', repo: 'rocket' })
    getRepoSlug.mockResolvedValue({ owner: 'acme', repo: 'rocket' })

    await (runtime as unknown as BackfillInternals).repositoryForkBackfill.run()

    expect(updateRepo).toHaveBeenCalledExactlyOnceWith('repo-1', {
      upstream: { owner: 'upstream-org', repo: 'rocket' },
      repoIcon: {
        type: 'image',
        src: 'https://github.com/upstream-org.png?size=64',
        source: 'github',
        label: 'upstream-org/rocket'
      }
    })
  })

  it('skips every row whose files sit on an SSH host', async () => {
    // Why: the incumbent guard read `repo.connectionId`, so a row minted with only the unified
    // spelling fell through and had its upstream read off this client's copy of the path. A
    // runtime row's nested target holds its files too, and is equally not ours to read.
    const runtime = new OrcaRuntimeService()
    const updateRepo = attachStore(runtime, [
      makeRepo({ id: 'repo-ssh', executionHostId: 'ssh:builder' }),
      makeRepo({ id: 'repo-openclaw', executionHostId: 'ssh:openclaw' }),
      makeRepo({ id: 'repo-nested', connectionId: 'nested-1', executionHostId: 'runtime:env-a' })
    ])

    await (runtime as unknown as BackfillInternals).repositoryForkBackfill.run()

    expect(getRepoUpstream).not.toHaveBeenCalled()
    expect(getRepoSlug).not.toHaveBeenCalled()
    expect(updateRepo).not.toHaveBeenCalled()
  })

  it('keeps an icon chosen while avatar detection is pending', async () => {
    const runtime = new OrcaRuntimeService()
    const repo = makeRepo()
    const repos = [repo]
    const updateRepo = attachStore(runtime, repos)
    getRepoUpstream.mockResolvedValue({ owner: 'upstream-org', repo: 'rocket' })
    let resolveSlug!: (value: { owner: string; repo: string }) => void
    let markSlugStarted!: () => void
    const slugStarted = new Promise<void>((resolve) => {
      markSlugStarted = resolve
    })
    getRepoSlug.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlug = resolve
          markSlugStarted()
        })
    )

    const backfill = (runtime as unknown as BackfillInternals).repositoryForkBackfill.run()
    await slugStarted
    repos[0] = { ...repo, repoIcon: { type: 'emoji', emoji: '🚀' } }
    resolveSlug({ owner: 'acme', repo: 'rocket-pro' })
    await backfill

    expect(updateRepo).toHaveBeenCalledExactlyOnceWith('repo-1', {
      upstream: { owner: 'upstream-org', repo: 'rocket' }
    })
  })
})
