import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/types'
import {
  LOCAL_GIT_USERNAME_TIMEOUT_RETRY_MS,
  type ResolvedGitUsername
} from './git/git-username'
import type * as GitUsernameModule from './git/git-username'

const resolveLocalGitUsernameDetailedMock = vi.hoisted(() => vi.fn())

vi.mock('./git/git-username', async (importOriginal) => ({
  ...(await importOriginal<typeof GitUsernameModule>()),
  resolveLocalGitUsernameDetailed: resolveLocalGitUsernameDetailedMock
}))

import {
  MAX_REPO_GIT_USERNAME_ATTEMPTED_LOCATIONS,
  enrichRepoGitUsernames,
  flushRepoGitUsernameEnrichmentForTests,
  getRepoGitUsernameAttemptedLocationCountForTests,
  hasRepoGitUsernameAttemptedLocationForTests,
  resetRepoGitUsernameEnrichmentForTests
} from './repo-git-username-enrichment'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'r1',
    path: 'C:/repos/one',
    displayName: 'One',
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  } as Repo
}

function makeStore(repos: Repo[]): {
  getRepos: () => Repo[]
  getRepo: (id: string) => Repo | undefined
  setResolvedRepoGitUsername: ReturnType<
    typeof vi.fn<(id: string, username: string, expectedLifecycle?: Repo) => boolean>
  >
} {
  return {
    getRepos: () => repos,
    getRepo: (id) => repos.find((repo) => repo.id === id),
    setResolvedRepoGitUsername: vi.fn((id: string, _username: string, expectedLifecycle?: Repo) =>
      repos.some(
        (repo) =>
          repo.id === id &&
          (!expectedLifecycle ||
            (repo.path === expectedLifecycle.path &&
              repo.addedAt === expectedLifecycle.addedAt &&
              (repo.connectionId ?? null) === (expectedLifecycle.connectionId ?? null) &&
              (repo.executionHostId ?? null) === (expectedLifecycle.executionHostId ?? null)))
      )
    )
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function resolved(username: string, authoritative = true): ResolvedGitUsername {
  return { username, authoritative }
}

describe('enrichRepoGitUsernames', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRepoGitUsernameEnrichmentForTests()
    resolveLocalGitUsernameDetailedMock.mockResolvedValue(resolved('demo-user'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves and persists usernames, then notifies once', async () => {
    const store = makeStore([makeRepo(), makeRepo({ id: 'r2', path: 'C:/repos/two' })])
    const onChanged = vi.fn()

    enrichRepoGitUsernames(store, { onChanged })
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(2)
    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith(
      'r1',
      'demo-user',
      expect.objectContaining({ id: 'r1' })
    )
    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith(
      'r2',
      'demo-user',
      expect.objectContaining({ id: 'r2' })
    )
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('skips folder, SSH, and runtime-host repos', async () => {
    const store = makeStore([
      makeRepo({ id: 'folder', kind: 'folder' }),
      makeRepo({ id: 'ssh', path: '/remote/repo', connectionId: 'conn-1' }),
      makeRepo({
        id: 'runtime',
        path: '/runtime/repo',
        executionHostId: 'runtime:environment-1'
      })
    ])

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).not.toHaveBeenCalled()
  })

  it('targets the local lifecycle when an SSH repo shares its ID', async () => {
    const sshRepo = makeRepo({
      id: 'shared',
      path: 'C:/repos/same',
      connectionId: 'ssh-target',
      executionHostId: 'ssh:ssh-target'
    })
    const localRepo = makeRepo({ id: 'shared', path: 'C:/repos/same', addedAt: 2 })
    const store = makeStore([sshRepo, localRepo])

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith(
      'shared',
      'demo-user',
      expect.objectContaining({ path: 'C:/repos/same', addedAt: 2 })
    )
  })

  it('probes each repo location at most once per session', async () => {
    const store = makeStore([makeRepo()])

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()
    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(1)
  })

  it('prunes attempted locations for removed repos', async () => {
    const oldRepo = makeRepo({ id: 'old', path: 'C:/repos/old' })
    const newRepo = makeRepo({ id: 'new', path: 'C:/repos/new' })
    const repos = [oldRepo]
    const store = makeStore(repos)

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(getRepoGitUsernameAttemptedLocationCountForTests()).toBe(1)
    expect(hasRepoGitUsernameAttemptedLocationForTests(oldRepo)).toBe(true)

    repos.splice(0, repos.length, newRepo)
    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(getRepoGitUsernameAttemptedLocationCountForTests()).toBe(1)
    expect(hasRepoGitUsernameAttemptedLocationForTests(oldRepo)).toBe(false)
    expect(hasRepoGitUsernameAttemptedLocationForTests(newRepo)).toBe(true)
    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(2)
  })

  it('caps attempted locations while retaining active recent repos', async () => {
    const repos = Array.from(
      { length: MAX_REPO_GIT_USERNAME_ATTEMPTED_LOCATIONS - 1 },
      (_, index) => makeRepo({ id: `repo-${index}`, path: `C:/repos/repo-${index}` })
    )
    const keepRepo = makeRepo({ id: 'keep', path: 'C:/repos/keep' })
    repos.push(keepRepo)
    const store = makeStore(repos)

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()
    const newRepo = makeRepo({ id: 'new', path: 'C:/repos/new' })
    repos.push(newRepo)
    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(getRepoGitUsernameAttemptedLocationCountForTests()).toBe(
      MAX_REPO_GIT_USERNAME_ATTEMPTED_LOCATIONS
    )
    expect(hasRepoGitUsernameAttemptedLocationForTests(repos[0]!)).toBe(false)
    expect(hasRepoGitUsernameAttemptedLocationForTests(keepRepo)).toBe(true)
    expect(hasRepoGitUsernameAttemptedLocationForTests(newRepo)).toBe(true)
    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(
      MAX_REPO_GIT_USERNAME_ATTEMPTED_LOCATIONS + 1
    )
  })

  it('defers the whole pipeline after a non-authoritative result, then retries', async () => {
    vi.useFakeTimers()
    resolveLocalGitUsernameDetailedMock
      .mockResolvedValueOnce(resolved('', false))
      .mockResolvedValue(resolved('recovered-user'))
    const store = makeStore([makeRepo()])
    const onChanged = vi.fn()

    enrichRepoGitUsernames(store, { onChanged })
    await flushRepoGitUsernameEnrichmentForTests()
    enrichRepoGitUsernames(store, { onChanged })
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(1)
    expect(store.setResolvedRepoGitUsername).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    expect(hasRepoGitUsernameAttemptedLocationForTests(makeRepo())).toBe(true)

    await vi.advanceTimersByTimeAsync(LOCAL_GIT_USERNAME_TIMEOUT_RETRY_MS + 1)
    enrichRepoGitUsernames(store, { onChanged })
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(2)
    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith(
      'r1',
      'recovered-user',
      expect.objectContaining({ id: 'r1' })
    )
    expect(onChanged).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(LOCAL_GIT_USERNAME_TIMEOUT_RETRY_MS + 1)
    enrichRepoGitUsernames(store, { onChanged })
    await flushRepoGitUsernameEnrichmentForTests()

    // Authoritative success replaces the retry timestamp with a session attempt.
    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(2)
  })

  it('scopes non-authoritative cooldowns to the exact repo lifecycle', async () => {
    resolveLocalGitUsernameDetailedMock
      .mockResolvedValueOnce(resolved('', false))
      .mockResolvedValue(resolved('replacement-user'))
    const repos = [makeRepo()]
    const store = makeStore(repos)

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    const runtimeReplacement = makeRepo({
      addedAt: 2,
      executionHostId: 'runtime:environment-1'
    })
    repos.splice(0, repos.length, runtimeReplacement)
    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(1)
    expect(hasRepoGitUsernameAttemptedLocationForTests(makeRepo())).toBe(false)

    const localReplacement = makeRepo({ addedAt: 3 })
    repos.splice(0, repos.length, localReplacement)
    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(2)
    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith(
      'r1',
      'replacement-user',
      expect.objectContaining({ addedAt: 3 })
    )
  })

  it('clears stale persisted usernames on an authoritative empty resolution', async () => {
    // Why: the user removed github.user / logged out of gh — a completed
    // probe returning '' must clear the stale prefix instead of pinning it.
    resolveLocalGitUsernameDetailedMock.mockResolvedValue(resolved('', true))
    const store = makeStore([makeRepo()])
    const onChanged = vi.fn()

    enrichRepoGitUsernames(store, { onChanged })
    await flushRepoGitUsernameEnrichmentForTests()

    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith(
      'r1',
      '',
      expect.objectContaining({ id: 'r1' })
    )
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('does not notify when the store reports no change', async () => {
    const store = makeStore([makeRepo()])
    store.setResolvedRepoGitUsername.mockReturnValue(false)
    const onChanged = vi.fn()

    enrichRepoGitUsernames(store, { onChanged })
    await flushRepoGitUsernameEnrichmentForTests()

    expect(onChanged).not.toHaveBeenCalled()
  })

  it('re-runs after the in-flight pass for repos added mid-pass', async () => {
    const repos = [makeRepo()]
    const store = makeStore(repos)
    let releaseFirstProbe!: () => void
    resolveLocalGitUsernameDetailedMock.mockImplementationOnce(
      () =>
        new Promise<ResolvedGitUsername>((resolve) => {
          releaseFirstProbe = () => resolve(resolved('demo-user'))
        })
    )

    enrichRepoGitUsernames(store)
    // A repo lands while the first pass is still probing r1.
    repos.push(makeRepo({ id: 'r2', path: 'C:/repos/two' }))
    enrichRepoGitUsernames(store)
    releaseFirstProbe()
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(2)
    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith(
      'r2',
      'demo-user',
      expect.objectContaining({ id: 'r2' })
    )
  })

  it('rejects a stale username after repo ID and path reuse, then retries the replacement', async () => {
    const oldProbe = deferred<ResolvedGitUsername>()
    resolveLocalGitUsernameDetailedMock.mockReturnValueOnce(oldProbe.promise)
    const repos = [makeRepo()]
    const store = makeStore(repos)

    enrichRepoGitUsernames(store)
    const replacement = makeRepo({ addedAt: 2 })
    repos.splice(0, repos.length, replacement)
    oldProbe.resolve(resolved('old-user'))
    await flushRepoGitUsernameEnrichmentForTests()

    expect(store.setResolvedRepoGitUsername).not.toHaveBeenCalled()
    expect(hasRepoGitUsernameAttemptedLocationForTests(replacement)).toBe(false)

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(2)
    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith(
      'r1',
      'demo-user',
      expect.objectContaining({ id: 'r1' })
    )
  })

  it('does not let a reset-era result mutate the new generation', async () => {
    const staleProbe = deferred<ResolvedGitUsername>()
    resolveLocalGitUsernameDetailedMock.mockReturnValueOnce(staleProbe.promise)
    const repo = makeRepo()
    const store = makeStore([repo])

    enrichRepoGitUsernames(store)
    resetRepoGitUsernameEnrichmentForTests()
    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledTimes(1)
    expect(store.setResolvedRepoGitUsername).toHaveBeenLastCalledWith(
      'r1',
      'demo-user',
      expect.objectContaining({ id: 'r1' })
    )
    staleProbe.resolve(resolved('stale-user'))
    await Promise.resolve()
    await Promise.resolve()

    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledTimes(1)
    expect(hasRepoGitUsernameAttemptedLocationForTests(repo)).toBe(true)
  })

  it('does not probe or mutate a runtime-host replacement after reset', async () => {
    const staleProbe = deferred<ResolvedGitUsername>()
    resolveLocalGitUsernameDetailedMock.mockReturnValueOnce(staleProbe.promise)
    const repos = [makeRepo()]
    const store = makeStore(repos)

    enrichRepoGitUsernames(store)
    resetRepoGitUsernameEnrichmentForTests()
    const replacement = makeRepo({ addedAt: 2, executionHostId: 'runtime:environment-1' })
    repos.splice(0, repos.length, replacement)
    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()
    staleProbe.resolve(resolved('stale-user'))
    await Promise.resolve()
    await Promise.resolve()

    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(1)
    expect(store.setResolvedRepoGitUsername).not.toHaveBeenCalled()
    expect(hasRepoGitUsernameAttemptedLocationForTests(replacement)).toBe(false)
  })

  it('uses the latest pending store and callback for the queued rerun', async () => {
    const firstProbe = deferred<ResolvedGitUsername>()
    resolveLocalGitUsernameDetailedMock.mockReturnValueOnce(firstProbe.promise)
    const firstStore = makeStore([makeRepo({ id: 'first', path: 'C:/repos/first' })])
    const droppedStore = makeStore([makeRepo({ id: 'dropped', path: 'C:/repos/dropped' })])
    const latestStore = makeStore([makeRepo({ id: 'latest', path: 'C:/repos/latest' })])
    const firstChanged = vi.fn()
    const droppedChanged = vi.fn()
    const latestChanged = vi.fn()

    enrichRepoGitUsernames(firstStore, { onChanged: firstChanged })
    enrichRepoGitUsernames(droppedStore, { onChanged: droppedChanged })
    enrichRepoGitUsernames(latestStore, { onChanged: latestChanged })
    firstProbe.resolve(resolved('first-user'))
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(2)
    expect(droppedStore.setResolvedRepoGitUsername).not.toHaveBeenCalled()
    expect(latestStore.setResolvedRepoGitUsername).toHaveBeenCalledWith(
      'latest',
      'demo-user',
      expect.objectContaining({ id: 'latest' })
    )
    expect(firstChanged).toHaveBeenCalledTimes(1)
    expect(droppedChanged).not.toHaveBeenCalled()
    expect(latestChanged).toHaveBeenCalledTimes(1)
  })
})
