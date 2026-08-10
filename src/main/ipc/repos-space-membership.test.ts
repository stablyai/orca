/**
 * Regression tests for which Space a newly added project lands in.
 *
 * Every window overwrites the single persisted `ui.activeSpaceId`, so main used to stamp a new
 * project with whichever Space switched last. Adding from a window sitting in "Personal" while
 * another window had switched to "Work" filed the project under Work, and the sidebar it was added
 * from never showed it. The requesting window now states its own Space on the IPC call.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Repo } from '../../shared/types'

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
    updateRepo: vi.fn(),
    syncProjectHostSetupCompatibilityState: vi.fn()
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

vi.mock('./filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: invalidateAuthorizedRootsCacheMock
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: prepareLocalWorktreeRootForRepoMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: vi.fn() }))
vi.mock('./ssh', () => ({ getActiveMultiplexer: vi.fn() }))

import { registerRepoHandlers } from './repos'

type AddResult = { repo: Repo } | { error: string }

describe('repos:add Space membership', () => {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
  const mockWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }

  const callAdd = (args: {
    path: string
    kind?: 'git' | 'folder'
    spaceId?: string | null
  }): Promise<AddResult> => {
    const handler = handlers.get('repos:add')
    if (!handler) {
      throw new Error('repos:add handler was never registered')
    }
    return handler(null, args) as Promise<AddResult>
  }

  const requestedSpaceId = (): unknown => mockStore.addRepo.mock.calls[0]?.[1]

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
    getGitRepoRootMock.mockReset().mockImplementation((path: string) => path)
    getLinkedWorktreeMainRepoRootMock.mockReset().mockReturnValue(null)
    detectRepoIconAndUpstreamMock.mockReset().mockResolvedValue({})
    invalidateAuthorizedRootsCacheMock.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('files the project in the Space the requesting window sent', async () => {
    await callAdd({ path: '/repos/orca', spaceId: 'space-personal' })

    expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
    expect(requestedSpaceId()).toBe('space-personal')
  })

  it('asks for Default when the caller states no Space', async () => {
    await callAdd({ path: '/repos/orca' })

    expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
    // Why: null, not undefined — undefined would let Store.addRepo fall back to a default of its own.
    expect(requestedSpaceId()).toBeNull()
  })

  it('asks for Default when the caller explicitly sends null', async () => {
    await callAdd({ path: '/repos/orca', spaceId: null })

    expect(requestedSpaceId()).toBeNull()
  })

  it('rejects a malformed Space id instead of forwarding it', async () => {
    await callAdd({ path: '/repos/orca', spaceId: '' })

    expect(requestedSpaceId()).toBeNull()
  })

  it('carries the Space through the folder-project path too', async () => {
    await callAdd({ path: '/notes', kind: 'folder', spaceId: 'space-work' })

    expect(requestedSpaceId()).toBe('space-work')
  })
})
