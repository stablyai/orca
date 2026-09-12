/**
 * Regression tests for repos:add + git worktrees.
 *
 * A linked worktree reports itself as its own `--show-toplevel`, so the path-based dedupe in
 * addLocalRepoFromPath cannot see that it belongs to an already-tracked repo. Adding it anyway
 * produced a second ready ProjectHostSetup on the same project and host — a duplicate "Local Mac"
 * run-target row pointing at a transient worktree path.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Repo } from '../../shared/repo-types'

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
    removeProject: vi.fn(),
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

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

vi.mock('../git/repo', () => ({
  isGitRepo: isGitRepoMock,
  getGitRepoRoot: getGitRepoRootMock,
  getLinkedWorktreeMainRepoRoot: getLinkedWorktreeMainRepoRootMock,
  getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop()),
  getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
  searchBaseRefs: vi.fn().mockResolvedValue([])
}))

vi.mock('../repo-detection', () => ({
  detectRepoIconAndUpstream: detectRepoIconAndUpstreamMock
}))

vi.mock('./registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: invalidateAuthorizedRootsCacheMock
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: prepareLocalWorktreeRootForRepoMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: vi.fn() }))
vi.mock('./ssh', () => ({ getActiveMultiplexer: vi.fn() }))

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
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler as (event: unknown, args: unknown) => unknown)
    })
    removeHandlerMock.mockReset()
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.addRepo.mockReset()
    isGitRepoMock.mockReset().mockReturnValue(true)
    // A linked worktree is its own toplevel — this is exactly why path dedupe alone misses it.
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

    expect(getLinkedWorktreeMainRepoRootMock).not.toHaveBeenCalled()
    expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
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
