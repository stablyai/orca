import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { partialRuntimeStore } from '../orca-runtime-tests/runtime-store-partial-fixture'
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

  it.each([12, 120])(
    'serializes and deduplicates a finite %i-row batch with one notice',
    async (count) => {
      const f = fixture(Array.from({ length: count }, (_, index) => makeRepo(`repo-${index}`)))
      const gate = Promise.withResolvers<RepoUpstreamProbe>()
      const started = Promise.withResolvers<void>()
      let active = 0
      let peak = 0
      probe.mockImplementation(async () => {
        active++
        peak = Math.max(peak, active)
        started.resolve()
        await gate.promise
        active--
        return { upstream: null, origin: null }
      })
      const batch = f.owner.run()
      await started.promise
      const duplicate = f.owner.enqueue(f.repos)
      const required = f.owner.resolve(f.repos[0])
      gate.resolve({ upstream: null, origin: null })
      await Promise.all([batch, duplicate, required])
      expect(peak).toBe(1)
      expect(probe).toHaveBeenCalledTimes(count)
      expect(f.updateRepo).toHaveBeenCalledTimes(count)
      expect(f.notify).toHaveBeenCalledTimes(1)
      await f.owner.run()
      expect(probe).toHaveBeenCalledTimes(count)
    }
  )

  it('publishes a completed finite batch while a later batch is still pending', async () => {
    const f = fixture([makeRepo('first'), makeRepo('later')])
    const first = Promise.withResolvers<RepoUpstreamProbe>()
    const later = Promise.withResolvers<RepoUpstreamProbe>()
    probe.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => later.promise)
    const a = f.owner.enqueue([f.repos[0]])
    const b = f.owner.enqueue([f.repos[1]])
    first.resolve({ upstream: null, origin: null })
    await a
    expect(f.notify).toHaveBeenCalledTimes(1)
    later.resolve({ upstream: null, origin: null })
    await b
    expect(f.notify).toHaveBeenCalledTimes(2)
  })

  it.each([12, 120])(
    'starts a required row ahead of %i unrelated background rows without duplicating it',
    async (count) => {
      const f = fixture(Array.from({ length: count }, (_, index) => makeRepo(`repo-${index}`)))
      const blocker = Promise.withResolvers<RepoUpstreamProbe>()
      probe
        .mockImplementationOnce(() => blocker.promise)
        .mockResolvedValue({ upstream: parent, origin })
      const batch = f.owner.run()
      const selected = f.owner.resolve(f.repos[count - 1])
      try {
        await vi.waitFor(() => expect(f.repos[count - 1].upstream).toEqual(parent))
        await selected
        expect(f.repos[0].upstream).toBeUndefined()
        expect(
          probe.mock.calls.filter(([path]) => path === `/workspace/repo-${count - 1}`)
        ).toHaveLength(1)
      } finally {
        blocker.resolve({ upstream: null, origin: null })
        await batch
      }
      expect(probe).toHaveBeenCalledTimes(count)
      expect(f.notify).toHaveBeenCalledTimes(1)
    }
  )

  it('reserves optional capacity and admits required jobs in request order with at most four active', async () => {
    const f = fixture(Array.from({ length: 8 }, (_, index) => makeRepo(`repo-${index}`)))
    const pending = new Map<string, ReturnType<typeof Promise.withResolvers<RepoUpstreamProbe>>>()
    const starts: string[] = []
    let active = 0
    let peak = 0
    probe.mockImplementation(async (path) => {
      active++
      peak = Math.max(peak, active)
      starts.push(path)
      const result = Promise.withResolvers<RepoUpstreamProbe>()
      pending.set(path, result)
      const value = await result.promise
      active--
      return value
    })
    const batch = f.owner.run()
    // Request order differs from the older background inventory order.
    const required = [5, 4, 3, 2, 1].map((index) => f.owner.resolve(f.repos[index]))
    const join = f.owner.resolve(f.repos[0])
    try {
      await vi.waitFor(() => expect(starts).toHaveLength(4))
      expect(starts).toEqual([
        '/workspace/repo-0',
        '/workspace/repo-5',
        '/workspace/repo-4',
        '/workspace/repo-3'
      ])
      pending.get('/workspace/repo-4')!.resolve({ upstream: null, origin: null })
      await vi.waitFor(() => expect(starts[4]).toBe('/workspace/repo-2'))
      pending.get('/workspace/repo-5')!.resolve({ upstream: null, origin: null })
      await vi.waitFor(() => expect(starts[5]).toBe('/workspace/repo-1'))
      expect(peak).toBe(4)
      expect(starts).not.toContain('/workspace/repo-6')
    } finally {
      probe.mockResolvedValue({ upstream: null, origin: null })
      for (const result of pending.values()) {
        result.resolve({ upstream: null, origin: null })
      }
      await Promise.all([batch, join, ...required])
    }
    expect(f.notify).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(8)
  })

  it.each([12, 120])(
    'does not serialize protected image payloads across %i rows',
    async (count) => {
      const icons = Array.from({ length: count }, (_, index) => ({
        type: 'image' as const,
        source: index % 2 ? ('upload' as const) : ('file' as const),
        src: `data:image/png;base64,${'a'.repeat(350_000)}`
      }))
      const f = fixture(icons.map((repoIcon, index) => makeRepo(`repo-${index}`, { repoIcon })))
      const gate = Promise.withResolvers<RepoUpstreamProbe>()
      const started = Promise.withResolvers<void>()
      probe
        .mockImplementationOnce(() => {
          started.resolve()
          return gate.promise
        })
        .mockResolvedValue({ upstream: parent, origin })
      const protectedIcons = new Set<unknown>(icons)
      const serialized = vi.spyOn(JSON, 'stringify')
      const batch = f.owner.run()
      await started.promise
      // A user replacing the captured protected image with an automatic icon must still survive.
      f.repos[0] = {
        ...f.repos[0],
        repoIcon: { type: 'image', source: 'github', src: 'https://github.com/chosen.png' }
      }
      gate.resolve({ upstream: parent, origin })
      await batch
      const protectedCopies = serialized.mock.calls.filter(([value]) => protectedIcons.has(value))
      serialized.mockRestore()
      expect(protectedCopies).toHaveLength(0)
      expect(f.repos.every((repo) => repo.upstream?.owner === 'acme')).toBe(true)
      expect(f.repos[0].repoIcon).toEqual({
        type: 'image',
        source: 'github',
        src: 'https://github.com/chosen.png'
      })
      expect(f.repos[1].repoIcon).toBe(icons[1])
      expect(f.notify).toHaveBeenCalledTimes(1)
    }
  )
})
