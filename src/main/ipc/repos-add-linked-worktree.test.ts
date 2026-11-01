/** Linked worktrees report their own toplevel; deduplicate by common repo to avoid duplicate run-target rows. */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type * as KeyedPromiseQueue from '../cli/keyed-promise-queue'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import { emitRepoAdded } from './repos/repo-added-telemetry'

const {
  handleMock,
  removeHandlerMock,
  mockStore,
  isGitRepoMock,
  getGitRepoRootMock,
  getLinkedWorktreeMainRepoRootMock,
  invalidateAuthorizedRootsCacheMock,
  prepareLocalWorktreeRootForRepoMock,
  detectRepoIconAndUpstreamMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  mockStore: {
    getRepos: vi.fn().mockReturnValue([]),
    addRepo: vi.fn(),
    getRepo: vi.fn(),
    updateRepo: vi.fn()
  },
  isGitRepoMock: vi.fn().mockReturnValue(true),
  getGitRepoRootMock: vi.fn(),
  getLinkedWorktreeMainRepoRootMock: vi.fn(),
  invalidateAuthorizedRootsCacheMock: vi.fn(),
  prepareLocalWorktreeRootForRepoMock: vi.fn(),
  detectRepoIconAndUpstreamMock: vi.fn()
}))

vi.mock('../cli/keyed-promise-queue', async (original) => {
  const actual = await original<typeof KeyedPromiseQueue>()
  return { ...actual, runKeyedSerializedOperation: vi.fn(actual.runKeyedSerializedOperation) }
})

vi.mock('./repos/repo-added-telemetry', () => ({ emitRepoAdded: vi.fn() }))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

vi.mock('../git/repo', () => ({
  isGitRepo: isGitRepoMock,
  isGitRepoAsync: isGitRepoMock,
  inspectGitRepoForRegistrationAsync: vi.fn((path: string) => ({
    isRepo: isGitRepoMock(path),
    rootPath: getGitRepoRootMock(path),
    mainRepoPath: getLinkedWorktreeMainRepoRootMock(path)
  })),
  getGitRepoRoot: getGitRepoRootMock,
  getGitRepoRootAsync: getGitRepoRootMock,
  getLinkedWorktreeMainRepoRoot: getLinkedWorktreeMainRepoRootMock,
  getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop()),
  getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
  searchBaseRefs: vi.fn().mockResolvedValue([])
}))

vi.mock('../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: detectRepoIconAndUpstreamMock
}))

vi.mock('./registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: invalidateAuthorizedRootsCacheMock
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: prepareLocalWorktreeRootForRepoMock
}))

import { registerRepoHandlers } from './repos'

const MAIN_CHECKOUT = '/Users/dev/projects/orca'
const LINKED_WORKTREE = '/Users/dev/orca/workspaces/orca/pr-3235'

type AddResult = { repo: Repo } | { error: string }

describe('repos:add with git worktrees', () => {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
  const mockWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }

  const trackedMainRepo = (): Repo =>
    ({
      id: 'main-repo-id',
      path: MAIN_CHECKOUT,
      displayName: 'orca',
      badgeColor: '#ef4444',
      addedAt: 1,
      kind: 'git'
    }) as Repo

  const callAdd = (args: { path: string; kind?: 'git' | 'folder' }): Promise<AddResult> => {
    const handler = handlers.get('repos:add')
    if (!handler) {
      throw new Error('repos:add handler was never registered')
    }
    return handler(null, args) as Promise<AddResult>
  }

  beforeEach(() => {
    vi.mocked(runKeyedSerializedOperation).mockClear()
    vi.mocked(emitRepoAdded).mockClear()
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler as (event: unknown, args: unknown) => unknown)
    })
    removeHandlerMock.mockReset()
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.addRepo.mockReset().mockImplementation((repo: Repo) => {
      mockStore.getRepos().push(repo)
    })
    isGitRepoMock.mockReset().mockReturnValue(true)
    // A linked worktree's own toplevel cannot identify its already-tracked main repo.
    getGitRepoRootMock.mockReset().mockImplementation((path: string) => path)
    getLinkedWorktreeMainRepoRootMock.mockReset().mockReturnValue(null)
    detectRepoIconAndUpstreamMock.mockReset().mockResolvedValue({})
    invalidateAuthorizedRootsCacheMock.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)

    registerRepoHandlers(mockWindow as never, mockStore as never, {} as never)
  })

  it('returns the tracked main checkout instead of adding its linked worktree', async () => {
    mockStore.getRepos.mockReturnValue([trackedMainRepo()])
    getLinkedWorktreeMainRepoRootMock.mockReturnValue(MAIN_CHECKOUT)

    const result = await callAdd({ path: LINKED_WORKTREE })

    expect(result).toEqual({ repo: expect.objectContaining({ id: 'main-repo-id' }) })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('still adds a linked worktree whose main checkout is not tracked', async () => {
    mockStore.getRepos.mockReturnValue([])
    getLinkedWorktreeMainRepoRootMock.mockReturnValue(MAIN_CHECKOUT)

    const result = await callAdd({ path: LINKED_WORKTREE })

    expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ repo: expect.objectContaining({ path: LINKED_WORKTREE }) })
  })

  it('adds a normal repo when git reports it is not a linked worktree', async () => {
    mockStore.getRepos.mockReturnValue([trackedMainRepo()])
    getLinkedWorktreeMainRepoRootMock.mockReturnValue(null)

    const result = await callAdd({ path: '/Users/dev/projects/other' })

    expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ repo: expect.objectContaining({ path: '/Users/dev/projects/other' }) })
  })

  it('does not consult worktree detection for folder projects', async () => {
    mockStore.getRepos.mockReturnValue([trackedMainRepo()])

    await callAdd({ path: '/Users/dev/notes', kind: 'folder' })

    expect(isGitRepoMock).not.toHaveBeenCalled()
    expect(getGitRepoRootMock).not.toHaveBeenCalled()
    expect(getLinkedWorktreeMainRepoRootMock).not.toHaveBeenCalled()
    expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
  })

  it.each(['git', 'folder'] as const)(
    'deduplicates concurrent %s registrations after pending icon discovery',
    async (kind) => {
      const repos: Repo[] = []
      mockStore.getRepos.mockImplementation(() => repos)
      mockStore.addRepo.mockImplementation((repo: Repo) => repos.push(repo))
      const discovery = Promise.withResolvers<object>()
      detectRepoIconAndUpstreamMock.mockReturnValueOnce(discovery.promise)
      const first = callAdd({ path: MAIN_CHECKOUT, kind })
      const second = callAdd({ path: MAIN_CHECKOUT, kind })
      try {
        await vi.waitFor(() => expect(detectRepoIconAndUpstreamMock).toHaveBeenCalledOnce())
        discovery.resolve({})
        const winner = await first
        expect(await second).toEqual(winner)
        expect(repos).toHaveLength(1)
        expect(emitRepoAdded).toHaveBeenCalledWith('folder_picker', false, kind === 'git')
        expect(emitRepoAdded).toHaveBeenCalledWith('folder_picker', true, kind === 'git')
        expect(emitRepoAdded).toHaveBeenCalledTimes(2)
        expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
        expect(detectRepoIconAndUpstreamMock).toHaveBeenCalledOnce()
      } finally {
        discovery.resolve({})
        await Promise.allSettled([first, second])
      }
    }
  )

  it('keeps a late main-checkout race result private while a folder at the linked path waits', async () => {
    const discovery = Promise.withResolvers<object>()
    detectRepoIconAndUpstreamMock.mockReturnValueOnce(discovery.promise).mockResolvedValue({})
    getLinkedWorktreeMainRepoRootMock.mockReturnValue(MAIN_CHECKOUT)
    const pending = callAdd({ path: LINKED_WORKTREE })
    await vi.waitFor(() => expect(detectRepoIconAndUpstreamMock).toHaveBeenCalledOnce())
    const folder = callAdd({ path: LINKED_WORKTREE, kind: 'folder' })
    try {
      await vi.waitFor(() => expect(runKeyedSerializedOperation).toHaveBeenCalledTimes(2))
      expect(detectRepoIconAndUpstreamMock).toHaveBeenCalledOnce()
      mockStore.getRepos().push(trackedMainRepo())
      discovery.resolve({ upstream: { owner: 'git-only', repo: 'metadata' } })
      expect(await pending).toEqual({ repo: expect.objectContaining({ id: 'main-repo-id' }) })
      expect(await folder).toEqual({
        repo: expect.objectContaining({ path: LINKED_WORKTREE, kind: 'folder' })
      })
      expect(mockStore.getRepos()).toHaveLength(2)
      expect(mockStore.getRepos()[1]).not.toHaveProperty('upstream')
      expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
      expect(detectRepoIconAndUpstreamMock).toHaveBeenCalledTimes(2)
    } finally {
      discovery.resolve({})
      await Promise.allSettled([pending, folder])
    }
  })

  it('matches the tracked main checkout across path separator differences', async () => {
    mockStore.getRepos.mockReturnValue([
      { ...trackedMainRepo(), path: 'C:\\Users\\dev\\projects\\orca' } as Repo
    ])
    getLinkedWorktreeMainRepoRootMock.mockReturnValue('C:/Users/dev/projects/orca')

    const result = await callAdd({ path: 'C:/Users/dev/worktrees/pr-3235' })

    expect(result).toEqual({ repo: expect.objectContaining({ id: 'main-repo-id' }) })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('does not match a folder record sitting on the main-checkout path', async () => {
    mockStore.getRepos.mockReturnValue([
      { ...trackedMainRepo(), id: 'folder-repo-id', kind: 'folder' } as Repo
    ])
    getLinkedWorktreeMainRepoRootMock.mockReturnValue(MAIN_CHECKOUT)

    const result = await callAdd({ path: LINKED_WORKTREE })

    expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ repo: expect.objectContaining({ path: LINKED_WORKTREE }) })
  })

  it('does not match a tracked SSH repo that shares the local main-checkout path', async () => {
    mockStore.getRepos.mockReturnValue([
      { ...trackedMainRepo(), id: 'ssh-repo-id', connectionId: 'builder' } as Repo
    ])
    getLinkedWorktreeMainRepoRootMock.mockReturnValue(MAIN_CHECKOUT)

    const result = await callAdd({ path: LINKED_WORKTREE })

    expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ repo: expect.objectContaining({ path: LINKED_WORKTREE }) })
  })
})
