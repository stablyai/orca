import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import type { ResolvedGitUsername } from './git/git-username'

const resolveLocalGitUsernameDetailedMock = vi.hoisted(() => vi.fn())

vi.mock('./git/git-username', () => ({
  resolveLocalGitUsernameDetailed: resolveLocalGitUsernameDetailedMock
}))

import {
  enrichRepoGitUsernames,
  flushRepoGitUsernameEnrichmentForTests,
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

type UsernameTarget = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

function makeStore(repos: Repo[]): {
  getRepos: () => Repo[]
  setResolvedRepoGitUsername: ReturnType<
    typeof vi.fn<(target: UsernameTarget, username: string) => boolean>
  >
} {
  return {
    getRepos: () => repos,
    setResolvedRepoGitUsername: vi.fn<(target: UsernameTarget, username: string) => boolean>(
      () => true
    )
  }
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

  it('resolves and persists usernames, then notifies once', async () => {
    const store = makeStore([makeRepo(), makeRepo({ id: 'r2', path: 'C:/repos/two' })])
    const onChanged = vi.fn()

    enrichRepoGitUsernames(store, { onChanged })
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(2)
    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1' }),
      'demo-user'
    )
    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r2' }),
      'demo-user'
    )
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('skips folder and SSH repos', async () => {
    const store = makeStore([
      makeRepo({ id: 'folder', kind: 'folder' }),
      makeRepo({ id: 'ssh', path: '/remote/repo', connectionId: 'conn-1' })
    ])

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).not.toHaveBeenCalled()
  })

  it('probes each repo location at most once per session', async () => {
    const store = makeStore([makeRepo()])

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()
    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(1)
  })

  it('probes a local and a runtime repo that share a path separately', async () => {
    const store = makeStore([
      makeRepo(),
      makeRepo({ id: 'r1-runtime', executionHostId: 'runtime:env-a' })
    ])

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameDetailedMock).toHaveBeenCalledTimes(2)
    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1-runtime' }),
      'demo-user'
    )
  })

  it('keeps persisted usernames on a non-authoritative empty resolution', async () => {
    resolveLocalGitUsernameDetailedMock.mockResolvedValue(resolved('', false))
    const store = makeStore([makeRepo()])
    const onChanged = vi.fn()

    enrichRepoGitUsernames(store, { onChanged })
    await flushRepoGitUsernameEnrichmentForTests()

    expect(store.setResolvedRepoGitUsername).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
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
      expect.objectContaining({ id: 'r1' }),
      ''
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
      expect.objectContaining({ id: 'r2' }),
      'demo-user'
    )
  })
})
