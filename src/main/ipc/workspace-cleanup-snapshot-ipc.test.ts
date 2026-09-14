import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'

const { persistScanResultMock, readScanSnapshotMock, scanWorkspaceCleanupMock } = vi.hoisted(
  () => ({
    persistScanResultMock: vi.fn(),
    readScanSnapshotMock: vi.fn(),
    scanWorkspaceCleanupMock: vi.fn()
  })
)

const { beginPruneBatchMock, finishPruneBatchMock, recordPruneMock } = vi.hoisted(() => ({
  beginPruneBatchMock: vi.fn(),
  finishPruneBatchMock: vi.fn().mockResolvedValue(undefined),
  recordPruneMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

vi.mock('../workspace-cleanup-scan-snapshot', () => ({
  persistWorkspaceCleanupScanResult: persistScanResultMock,
  readWorkspaceCleanupScanSnapshot: readScanSnapshotMock
}))

vi.mock('./workspace-cleanup-scan', () => ({
  scanWorkspaceCleanup: scanWorkspaceCleanupMock
}))

vi.mock('../workspace-cleanup-removal-snapshot-prune', () => ({
  beginWorkspaceCleanupRemovalSnapshotPruneBatch: beginPruneBatchMock,
  finishWorkspaceCleanupRemovalSnapshotPruneBatch: finishPruneBatchMock,
  recordWorkspaceCleanupRemovalSnapshotPrune: recordPruneMock
}))

import { registerWorkspaceCleanupHandlers } from './workspace-cleanup'

const NOW = 1_700_000_000_000

function makeScanEvent(senderOverrides: Record<string, unknown> = {}): never {
  return {
    sender: {
      id: 1,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      ...senderOverrides
    }
  } as never
}

function makeEmptyStore(): Store {
  return {
    getProfileStorageDirectory: () => '/profile-a',
    getRepos: () => [],
    getWorktreeMeta: () => ({}),
    getAllWorktreeMeta: () => ({}),
    getGitHubCache: () => ({ pr: {}, issue: {} })
  } as unknown as Store
}

describe('workspace cleanup snapshot IPC', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
    persistScanResultMock.mockReset().mockResolvedValue(undefined)
    readScanSnapshotMock.mockReset()
    scanWorkspaceCleanupMock.mockReset().mockImplementation(async (_store, args, options) => {
      const result = { scannedAt: NOW, candidates: [], errors: [] }
      options.onProgress?.({
        scanId: args.scanId,
        scannedAt: NOW,
        scannedWorktreeCount: 0,
        totalWorktreeCount: 0,
        candidates: [],
        errors: []
      })
      return result
    })
    beginPruneBatchMock.mockReset()
    finishPruneBatchMock.mockReset().mockResolvedValue(undefined)
    recordPruneMock.mockReset()
  })

  it('persists the completed scan result after replying', async () => {
    registerWorkspaceCleanupHandlers(makeEmptyStore())
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'workspaceCleanup:scan')?.[1]

    const args = { includeAllWorkspaces: true }
    const result = await handler?.(makeScanEvent(), args)

    expect(persistScanResultMock).toHaveBeenCalledWith('/profile-a', args, result)
  })

  it('does not rewrite the fleet snapshot for a focused scan', async () => {
    registerWorkspaceCleanupHandlers(makeEmptyStore())
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'workspaceCleanup:scan')?.[1]

    await handler?.(makeScanEvent(), { worktreeId: 'repo-1::/repo-feature' })

    expect(persistScanResultMock).not.toHaveBeenCalled()
  })

  it('does not rewrite the fleet snapshot for a targeted evidence batch', async () => {
    registerWorkspaceCleanupHandlers(makeEmptyStore())
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'workspaceCleanup:scan')?.[1]

    await handler?.(makeScanEvent(), {
      worktreeIds: ['repo-1::/repo-a', 'repo-1::/repo-b']
    })

    expect(persistScanResultMock).not.toHaveBeenCalled()
  })

  it('does not persist an empty-target scan over the fleet snapshot', async () => {
    registerWorkspaceCleanupHandlers(makeEmptyStore())
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'workspaceCleanup:scan')?.[1]

    // Why: worktreeIds: [] is a targeted scan that returns nothing; persisting
    // it as broad would wipe the fleet cache.
    await handler?.(makeScanEvent(), { worktreeIds: [], includeAllWorkspaces: true })

    expect(persistScanResultMock).not.toHaveBeenCalled()
  })

  it('stops streaming progress after the invoking renderer is destroyed', async () => {
    registerWorkspaceCleanupHandlers(makeEmptyStore())
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'workspaceCleanup:scan')?.[1]
    const send = vi.fn(() => {
      throw new Error('Object has been destroyed')
    })

    await expect(
      handler?.(makeScanEvent({ isDestroyed: () => true, send }), { scanId: 'scan-1' })
    ).resolves.toEqual({ scannedAt: NOW, candidates: [], errors: [] })
    expect(send).not.toHaveBeenCalled()
  })

  it('aborts the scan when the invoking renderer is destroyed mid-flight', async () => {
    let abortListener: (() => void) | undefined
    scanWorkspaceCleanupMock.mockImplementation((_store, _args, options) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true
        })
      })
    })
    registerWorkspaceCleanupHandlers(makeEmptyStore())
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'workspaceCleanup:scan')?.[1]
    const event = makeScanEvent({
      once: vi.fn((eventName: string, listener: () => void) => {
        if (eventName === 'destroyed') {
          abortListener = listener
        }
      })
    })

    const scan = handler?.(event, { includeAllWorkspaces: true })
    abortListener?.()
    await expect(scan).rejects.toThrow('cancelled')
  })

  it('keeps legacy suggestion-only and full broad scans isolated across modes', async () => {
    scanWorkspaceCleanupMock.mockImplementation((_store, _args, options) => {
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true
        })
        setTimeout(() => resolve({ scannedAt: NOW, candidates: [], errors: [] }), 5)
      })
    })
    registerWorkspaceCleanupHandlers(makeEmptyStore())
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'workspaceCleanup:scan')?.[1]

    // Why: different includeAllWorkspaces modes are separate lanes; one must
    // not abort the other even from the same renderer.
    const [legacy, full] = await Promise.allSettled([
      handler?.(makeScanEvent({ id: 7 }), { includeAllWorkspaces: false }) as Promise<unknown>,
      handler?.(makeScanEvent({ id: 7 }), { includeAllWorkspaces: true }) as Promise<unknown>
    ])

    expect(legacy?.status).toBe('fulfilled')
    expect(full?.status).toBe('fulfilled')
  })

  it('supersedes a concurrent broad scan from the same renderer', async () => {
    const settlements: Promise<unknown>[] = []
    scanWorkspaceCleanupMock.mockImplementation((_store, _args, options) => {
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true
        })
        setTimeout(() => resolve({ scannedAt: NOW, candidates: [], errors: [] }), 5)
      })
    })
    registerWorkspaceCleanupHandlers(makeEmptyStore())
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'workspaceCleanup:scan')?.[1]

    settlements.push(
      handler?.(makeScanEvent({ id: 7 }), { includeAllWorkspaces: true }) as Promise<unknown>,
      handler?.(makeScanEvent({ id: 7 }), { includeAllWorkspaces: true }) as Promise<unknown>
    )
    const [first, second] = await Promise.allSettled(settlements)

    expect(first?.status).toBe('rejected')
    expect(second?.status).toBe('fulfilled')
  })

  it('cancels only the invoking renderer scan id', async () => {
    scanWorkspaceCleanupMock.mockImplementation((_store, _args, options) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true
        })
      })
    })
    registerWorkspaceCleanupHandlers(makeEmptyStore())
    const handlers = Object.fromEntries(vi.mocked(ipcMain.handle).mock.calls)
    const event = makeScanEvent({ id: 7 })

    const scan = handlers['workspaceCleanup:scan']?.(event, { scanId: 'scan-1' })
    expect(handlers['workspaceCleanup:cancelScan']?.(event, 'scan-1')).toBe(true)
    await expect(scan).rejects.toThrow('cancelled')
    expect(
      handlers['workspaceCleanup:cancelScan']?.({ sender: { id: 8 } } as never, 'scan-1')
    ).toBe(false)
  })

  it('serves the cached scan snapshot through getCachedScan', async () => {
    const snapshot = { scannedAt: NOW, candidates: [], errors: [] }
    readScanSnapshotMock.mockResolvedValue(snapshot)
    registerWorkspaceCleanupHandlers(makeEmptyStore())
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'workspaceCleanup:getCachedScan')?.[1]

    await expect(handler?.({} as never)).resolves.toBe(snapshot)
    expect(readScanSnapshotMock).toHaveBeenCalledWith('/profile-a')
    expect(vi.mocked(ipcMain.removeHandler)).toHaveBeenCalledWith('workspaceCleanup:getCachedScan')
  })

  it('persists same-id dismissals by host and prunes every key by worktree id', async () => {
    let dismissals = {}
    const store = {
      ...makeEmptyStore(),
      getUI: () => ({ workspaceCleanup: { dismissals } }),
      updateUI: (update: { workspaceCleanup: { dismissals: typeof dismissals } }) => {
        dismissals = update.workspaceCleanup.dismissals
      }
    } as unknown as Store
    registerWorkspaceCleanupHandlers(store)
    const handler = Object.fromEntries(vi.mocked(ipcMain.handle).mock.calls)[
      'workspaceCleanup:dismiss'
    ]
    const base = {
      worktreeId: 'repo-1::/same',
      dismissedAt: NOW,
      fingerprint: 'fp',
      classifierVersion: 2
    }

    await handler?.({} as never, {
      dismissals: [
        { ...base, executionHostId: 'local' },
        { ...base, executionHostId: 'ssh:ssh-1' }
      ]
    })

    expect(Object.keys(dismissals).sort()).toEqual(
      ['local\0repo-1::/same', 'ssh:ssh-1\0repo-1::/same'].sort()
    )

    await handler?.({} as never, { dismissals: [], removedWorktreeIds: [base.worktreeId] })
    expect(dismissals).toEqual({})
  })

  it('routes a validated removal snapshot prune batch through its explicit boundary', async () => {
    registerWorkspaceCleanupHandlers(makeEmptyStore())
    const handlers = Object.fromEntries(vi.mocked(ipcMain.handle).mock.calls)
    const batch = { batchId: 'batch-1' }
    const target = {
      ...batch,
      worktreeId: 'repo-ssh::/remote/feature',
      executionHostId: 'ssh:ssh-1'
    }

    await handlers['workspaceCleanup:beginRemovalSnapshotPruneBatch']?.({} as never, batch)
    await handlers['workspaceCleanup:recordRemovalSnapshotPrune']?.({} as never, target)
    await handlers['workspaceCleanup:finishRemovalSnapshotPruneBatch']?.({} as never, batch)

    expect(beginPruneBatchMock).toHaveBeenCalledExactlyOnceWith('/profile-a', batch)
    expect(recordPruneMock).toHaveBeenCalledExactlyOnceWith('/profile-a', target)
    expect(finishPruneBatchMock).toHaveBeenCalledExactlyOnceWith('/profile-a', batch)
  })
})
