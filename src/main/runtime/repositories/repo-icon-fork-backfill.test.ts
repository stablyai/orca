import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import * as repoSlugUpstream from '../../github/client/fetch/repo-slug-upstream'
import { OrcaRuntimeService } from '../orca-runtime'
import { repoTarget } from '../../persistence/repo-host-target-matcher.test-fixture'

vi.mock('../../github/client/fetch/repo-slug-upstream', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRepoSlug: vi.fn(),
  getRepoUpstream: vi.fn()
}))

const getRepoUpstream = vi.mocked(repoSlugUpstream.getRepoUpstream)
const getRepoSlug = vi.mocked(repoSlugUpstream.getRepoSlug)

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
  const updateRepo = vi.fn((target: Pick<Repo, 'id'>, updates: Partial<Repo>) => {
    const index = repos.findIndex((repo) => repo.id === target.id)
    repos[index] = { ...repos[index], ...updates }
  })
  Object.assign(runtime, { store: { getRepos: () => repos, updateRepo } })
  return updateRepo
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('startup fork-upstream backfill', () => {
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

    expect(updateRepo).toHaveBeenCalledExactlyOnceWith(repoTarget('repo-1'), {
      upstream: { owner: 'upstream-org', repo: 'rocket' }
    })
  })
})
