import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type * as RepoWorktrees from '../repo-worktrees'

const boundary = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  list: vi.fn(),
  status: vi.fn(),
  persist: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (event: unknown, args: unknown) => unknown) =>
      boundary.handlers.set(name, fn),
    removeHandler: (name: string) => boundary.handlers.delete(name)
  }
}))
vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(async () => ({ mtimeMs: 0 })),
  readFile: vi.fn(async () => {
    throw new Error('no gitdir pointer')
  })
}))
vi.mock('../repo-worktrees', async (importOriginal) => ({
  ...(await importOriginal<typeof RepoWorktrees>()),
  listRepoWorktrees: boundary.list
}))
vi.mock('../git/status', () => ({ getStatus: boundary.status }))
vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(async () => ({ stdout: '0\n', stderr: '' }))
}))
vi.mock('../project-runtime-git-options', () => ({ getLocalProjectWorktreeGitOptions: () => ({}) }))
vi.mock('../workspace-cleanup-scan-snapshot', () => ({
  persistWorkspaceCleanupScanResult: boundary.persist,
  readWorkspaceCleanupScanSnapshot: vi.fn()
}))
vi.mock('../workspace-cleanup-removal-snapshot-prune', () => ({
  beginWorkspaceCleanupRemovalSnapshotPruneBatch: vi.fn(),
  finishWorkspaceCleanupRemovalSnapshotPruneBatch: vi.fn(),
  recordWorkspaceCleanupRemovalSnapshotPrune: vi.fn()
}))

import { registerWorkspaceCleanupHandlers } from './workspace-cleanup'

const NOW = Date.UTC(2025, 0, 1)
const STATUS: GitStatusResult = {
  entries: [],
  conflictOperation: 'unknown',
  upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
}
class Sender extends EventEmitter {
  id = 9
  send = vi.fn()
  isDestroyed(): boolean {
    return false
  }
}
function rows(size: number, prefix = 'workspace'): GitWorktreeInfo[] {
  return Array.from({ length: size }, (_, index) => ({
    path: `/${prefix}-${index}`,
    head: 'abc',
    branch: `refs/heads/branch-${index}`,
    isBare: false,
    isMainWorktree: false
  }))
}
function setup() {
  const store = {
    getRepos: () => [
      {
        id: 'repo',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000',
        addedAt: NOW,
        symlinkPaths: []
      }
    ],
    getWorktreeMeta: () => ({ lastActivityAt: NOW - 40 * 24 * 60 * 60 * 1000 }),
    getAllWorktreeMeta: () => ({}),
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    getProfileStorageDirectory: () => 'unused'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The actual scanner reads only these store methods; mergeWorktree supplies missing metadata defaults.
  registerWorkspaceCleanupHandlers(store as never)
  const handler = boundary.handlers.get('workspaceCleanup:scan')
  if (!handler) {
    throw new Error('Missing scan handler')
  }
  const sender = new Sender()
  return {
    sender,
    scan: (scanId: string) =>
      Promise.resolve(handler({ sender }, { scanId, includeAllWorkspaces: true }))
  }
}

describe('workspace cleanup document ownership', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    boundary.handlers.clear()
    boundary.list.mockReset().mockResolvedValue(rows(10))
    boundary.status.mockReset().mockResolvedValue(STATUS)
    boundary.persist.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => vi.restoreAllMocks())
  it.each(
    [10, 100].flatMap((size) =>
      ['destroyed', 'render-process-gone', 'did-navigate'].map((event) => ({ size, event }))
    )
  )(
    'cancels $size rows after $event without dispatching beyond active reads',
    async ({ size, event }) => {
      boundary.list.mockResolvedValue(rows(size))
      const pending = Promise.withResolvers<GitStatusResult>()
      boundary.status.mockReturnValue(pending.promise)
      const { sender, scan } = setup()
      const outcome = scan('retired').then(
        () => 'complete',
        () => 'cancelled'
      )
      await vi.waitFor(() => expect(boundary.status).toHaveBeenCalledTimes(3))
      sender.send.mockClear()
      sender.emit(event)
      pending.resolve(STATUS)
      expect(await outcome).toBe('cancelled')
      expect(boundary.status).toHaveBeenCalledTimes(3)
      expect(sender.send).not.toHaveBeenCalled()
      expect(boundary.persist).not.toHaveBeenCalled()
      expect(sender.eventNames()).toEqual([])
    }
  )
  it('preserves same-document navigation and persists a completed scan', async () => {
    const pending = Promise.withResolvers<GitStatusResult>()
    boundary.status.mockReturnValue(pending.promise)
    const { sender, scan } = setup()
    const result = scan('live')
    await vi.waitFor(() => expect(boundary.status).toHaveBeenCalledTimes(3))
    sender.emit('did-navigate-in-page', {}, '#section', true)
    pending.resolve(STATUS)
    await result
    expect(boundary.status).toHaveBeenCalledTimes(10)
    expect(boundary.persist).toHaveBeenCalledTimes(1)
    expect(sender.eventNames()).toEqual([])
  })
  it('lets a successor finish while late retired reads settle', async () => {
    const pending = Promise.withResolvers<GitStatusResult>()
    boundary.list
      .mockResolvedValueOnce(rows(10, 'retired'))
      .mockResolvedValue(rows(10, 'replacement'))
    boundary.status.mockImplementation((path: string) =>
      path.startsWith('/retired') ? pending.promise : Promise.resolve(STATUS)
    )
    const { sender, scan } = setup()
    const old = scan('retired').then(
      () => 'complete',
      () => 'cancelled'
    )
    await vi.waitFor(() => expect(boundary.status).toHaveBeenCalledTimes(3))
    sender.emit('render-process-gone')
    sender.send.mockClear()
    await scan('replacement')
    pending.resolve(STATUS)
    expect(await old).toBe('cancelled')
    expect(boundary.status).toHaveBeenCalledTimes(13)
    expect(boundary.persist).toHaveBeenCalledTimes(1)
    expect(sender.send.mock.calls.every(([, progress]) => progress.scanId === 'replacement')).toBe(
      true
    )
    expect(sender.eventNames()).toEqual([])
  })
})
