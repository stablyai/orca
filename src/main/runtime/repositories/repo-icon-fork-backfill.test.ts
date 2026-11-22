import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import { partialRuntimeStore } from '../construction/test-context/runtime-store-partial-fixture'
import {
  probeRepoUpstream,
  type RepoUpstreamProbe
} from '../../github/client/fetch/repo-slug-upstream'
import { RuntimeRepositoryForkBackfill } from './runtime-repository-fork-backfill'

vi.mock('../../github/client/fetch/repo-slug-upstream', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  probeRepoUpstream: vi.fn()
}))
const probe = vi.mocked(probeRepoUpstream)
const origin = { owner: 'me', repo: 'widget', host: 'github.com' }
const originIcon = {
  type: 'image',
  src: 'https://github.com/me.png?size=64',
  source: 'github',
  label: 'me/widget'
}
const parent = { owner: 'acme', repo: 'widget', host: 'github.com' }
function makeRepo(id = 'repo-1', overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/workspace/${id}`,
    displayName: 'widget',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}
function fixture(repos: Repo[]) {
  const updateRepo = vi.fn((target: Pick<Repo, 'id'>, updates: Partial<Repo>) => {
    const index = repos.findIndex((repo) => repo.id === target.id)
    if (index === -1) {
      return null
    }
    repos[index] = { ...repos[index], ...updates }
    return repos[index]
  })
  const store = partialRuntimeStore({
    getRepos: () => repos,
    getRepo: (id) => repos.find((repo) => repo.id === id),
    updateRepo
  })
  const notify = vi.fn()
  return {
    owner: new RuntimeRepositoryForkBackfill(() => store, notify),
    repos,
    notify,
    updateRepo
  }
}
afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})

describe('repository metadata ownership', () => {
  it('keeps unavailable parent evidence unknown, fills origin avatar, and recovers on startup', async () => {
    const f = fixture([makeRepo()])
    probe
      .mockResolvedValueOnce({ upstream: undefined, origin })
      .mockResolvedValueOnce({ upstream: parent, origin })
    await f.owner.run()
    expect(f.repos[0].upstream).toBeUndefined()
    expect(f.repos[0].repoIcon).toEqual(originIcon)
    await f.owner.run()
    expect(f.repos[0].upstream).toEqual(parent)
    expect(f.repos[0].repoIcon).toEqual({
      ...originIcon,
      src: 'https://github.com/acme.png?size=64',
      label: 'acme/widget'
    })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(f.notify).toHaveBeenCalledTimes(2)
  })

  it('does not reprobe a proved negative or an explicit null icon', async () => {
    const f = fixture([makeRepo('negative'), makeRepo('explicit', { repoIcon: null })])
    probe.mockResolvedValue({ upstream: null, origin: null })
    await f.owner.run()
    await f.owner.run()
    expect(f.repos.map((repo) => repo.upstream)).toEqual([null, null])
    expect(f.repos[1].repoIcon).toBeNull()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(f.notify).toHaveBeenCalledTimes(1)
  })

  it.each(['removed', 'moved', 'folder', 'chosen-icon', 'selected-origin'] as const)(
    'rejects stale metadata after %s changes while hosted work is pending',
    async (change) => {
      const f = fixture([makeRepo()])
      const result = Promise.withResolvers<RepoUpstreamProbe>()
      const started = Promise.withResolvers<void>()
      probe.mockImplementationOnce(() => {
        started.resolve()
        return result.promise
      })
      const work = f.owner.run()
      await started.promise
      if (change === 'removed') {
        f.repos.splice(0, 1)
      }
      if (change === 'moved') {
        f.repos[0] = { ...f.repos[0], path: '/elsewhere' }
      }
      if (change === 'folder') {
        f.repos[0] = { ...f.repos[0], kind: 'folder' }
      }
      if (change === 'chosen-icon') {
        f.repos[0] = { ...f.repos[0], repoIcon: { type: 'emoji', emoji: '🚀' } }
      }
      if (change === 'selected-origin') {
        f.repos[0] = { ...f.repos[0], upstream: null }
      }
      result.resolve({ upstream: parent, origin })
      await work
      if (change === 'chosen-icon') {
        expect(f.repos[0].repoIcon).toEqual({ type: 'emoji', emoji: '🚀' })
        expect(f.repos[0].upstream).toEqual(parent)
      } else if (change === 'selected-origin') {
        expect(f.repos[0].upstream).toBeNull()
        expect(f.repos[0].repoIcon).toEqual(originIcon)
      } else {
        expect(f.updateRepo).not.toHaveBeenCalled()
      }
    }
  )

  it('resolves a required repo while a background probe is blocked', async () => {
    const f = fixture([makeRepo('background'), makeRepo('required')])
    const blocker = Promise.withResolvers<RepoUpstreamProbe>()
    probe
      .mockImplementationOnce(() => blocker.promise)
      .mockResolvedValue({ upstream: parent, origin })
    const batch = f.owner.run()
    const selected = f.owner.resolve(f.repos[1])
    try {
      await vi.waitFor(() => expect(f.repos[1].upstream).toEqual(parent))
      await selected
      expect(f.repos[0].upstream).toBeUndefined()
    } finally {
      blocker.resolve({ upstream: null, origin: null })
      await batch
    }
  })
})
