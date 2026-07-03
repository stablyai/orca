import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/types'

const resolveLocalGitUsernameMock = vi.hoisted(() => vi.fn())

vi.mock('./git/git-username', () => ({
  resolveLocalGitUsername: resolveLocalGitUsernameMock
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

function makeStore(repos: Repo[]): {
  getRepos: () => Repo[]
  setResolvedRepoGitUsername: ReturnType<typeof vi.fn<(id: string, username: string) => boolean>>
} {
  return {
    getRepos: () => repos,
    setResolvedRepoGitUsername: vi.fn<(id: string, username: string) => boolean>(() => true)
  }
}

describe('enrichRepoGitUsernames', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRepoGitUsernameEnrichmentForTests()
    resolveLocalGitUsernameMock.mockResolvedValue('demo-user')
  })

  it('resolves and persists usernames, then notifies once', async () => {
    const store = makeStore([makeRepo(), makeRepo({ id: 'r2', path: 'C:/repos/two' })])
    const onChanged = vi.fn()

    enrichRepoGitUsernames(store, { onChanged })
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameMock).toHaveBeenCalledTimes(2)
    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith('r1', 'demo-user')
    expect(store.setResolvedRepoGitUsername).toHaveBeenCalledWith('r2', 'demo-user')
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('skips folder and SSH repos', async () => {
    const store = makeStore([
      makeRepo({ id: 'folder', kind: 'folder' }),
      makeRepo({ id: 'ssh', path: '/remote/repo', connectionId: 'conn-1' })
    ])

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameMock).not.toHaveBeenCalled()
  })

  it('probes each repo location at most once per session', async () => {
    const store = makeStore([makeRepo()])

    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()
    enrichRepoGitUsernames(store)
    await flushRepoGitUsernameEnrichmentForTests()

    expect(resolveLocalGitUsernameMock).toHaveBeenCalledTimes(1)
  })

  it('does not clear persisted usernames on empty resolution and does not notify', async () => {
    resolveLocalGitUsernameMock.mockResolvedValue('')
    const store = makeStore([makeRepo()])
    const onChanged = vi.fn()

    enrichRepoGitUsernames(store, { onChanged })
    await flushRepoGitUsernameEnrichmentForTests()

    expect(store.setResolvedRepoGitUsername).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('does not notify when the store reports no change', async () => {
    const store = makeStore([makeRepo()])
    store.setResolvedRepoGitUsername.mockReturnValue(false)
    const onChanged = vi.fn()

    enrichRepoGitUsernames(store, { onChanged })
    await flushRepoGitUsernameEnrichmentForTests()

    expect(onChanged).not.toHaveBeenCalled()
  })
})
