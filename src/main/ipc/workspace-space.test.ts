import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceAnalyzeResult,
  WorkspaceSpaceScanProgress
} from '../../shared/workspace-space-types'
import type { Store } from '../persistence'

const {
  handlers,
  analyzeWorkspaceSpaceMock,
  removeHandlerMock,
  handleMock,
  persistAnalysisSnapshotMock,
  readAnalysisSnapshotMock,
  WorkspaceSpaceScanCancelledErrorMock
} = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  return {
    handlers,
    analyzeWorkspaceSpaceMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    handleMock: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler)
    }),
    persistAnalysisSnapshotMock: vi.fn(),
    readAnalysisSnapshotMock: vi.fn(),
    WorkspaceSpaceScanCancelledErrorMock: class WorkspaceSpaceScanCancelledError extends Error {}
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock
  }
}))

vi.mock('../workspace-space-analysis', () => ({
  WorkspaceSpaceScanCancelledError: WorkspaceSpaceScanCancelledErrorMock,
  analyzeWorkspaceSpace: analyzeWorkspaceSpaceMock
}))

vi.mock('../workspace-space-analysis-snapshot', () => ({
  persistWorkspaceSpaceAnalysisSnapshot: persistAnalysisSnapshotMock,
  readWorkspaceSpaceAnalysisSnapshot: readAnalysisSnapshotMock
}))

import { registerWorkspaceSpaceHandlers } from './workspace-space'

function createAnalysis(scannedAt: number): WorkspaceSpaceAnalysis {
  return {
    scannedAt,
    totalSizeBytes: 0,
    reclaimableBytes: 0,
    worktreeCount: 0,
    scannedWorktreeCount: 0,
    unavailableWorktreeCount: 0,
    repos: [],
    worktrees: []
  }
}

function createAnalyzeResult(scannedAt: number): WorkspaceSpaceAnalyzeResult {
  return { ok: true, analysis: createAnalysis(scannedAt) }
}

function createEvent() {
  return {
    sender: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn()
    }
  }
}

function createStore(): Store {
  return { getProfileStorageDirectory: () => '/profile-a' } as Store
}

describe('registerWorkspaceSpaceHandlers', () => {
  beforeEach(() => {
    analyzeWorkspaceSpaceMock.mockReset()
    persistAnalysisSnapshotMock.mockReset().mockResolvedValue(undefined)
    readAnalysisSnapshotMock.mockReset().mockResolvedValue(null)
  })

  it('shares an in-flight analysis request', async () => {
    const store = createStore()
    let resolveFirstScan: (analysis: WorkspaceSpaceAnalysis) => void = () => {}
    const firstScan = new Promise<WorkspaceSpaceAnalysis>((resolve) => {
      resolveFirstScan = resolve
    })
    const secondScan = Promise.resolve(createAnalysis(2))
    analyzeWorkspaceSpaceMock.mockReturnValueOnce(firstScan).mockReturnValueOnce(secondScan)

    registerWorkspaceSpaceHandlers(store)
    expect(removeHandlerMock).toHaveBeenCalledWith('workspaceSpace:analyze')

    const handler = handlers.get('workspaceSpace:analyze')
    expect(handler).toBeDefined()

    const firstEvent = createEvent()
    const secondEvent = createEvent()
    const first = handler!(firstEvent)
    const duplicate = handler!(secondEvent)
    expect(analyzeWorkspaceSpaceMock).toHaveBeenCalledTimes(1)
    expect(analyzeWorkspaceSpaceMock).toHaveBeenCalledWith(
      store,
      expect.objectContaining({
        scanId: expect.any(String),
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function)
      })
    )

    const firstResult = createAnalysis(1)
    resolveFirstScan(firstResult)
    await expect(first).resolves.toEqual({ ok: true, analysis: firstResult })
    await expect(duplicate).resolves.toEqual({ ok: true, analysis: firstResult })

    await expect(handler!(createEvent())).resolves.toEqual(createAnalyzeResult(2))
    expect(analyzeWorkspaceSpaceMock).toHaveBeenCalledTimes(2)
  })

  it('forwards scan progress to the requesting renderer', async () => {
    const store = createStore()
    let onProgress: ((progress: WorkspaceSpaceScanProgress) => void) | undefined
    analyzeWorkspaceSpaceMock.mockImplementationOnce((_store, options) => {
      onProgress = options.onProgress
      return Promise.resolve(createAnalysis(1))
    })

    registerWorkspaceSpaceHandlers(store)
    const event = createEvent()
    const handler = handlers.get('workspaceSpace:analyze')
    const promise = handler!(event)
    const progress: WorkspaceSpaceScanProgress = {
      scanId: 'scan-1',
      state: 'running',
      startedAt: 1,
      updatedAt: 1,
      totalRepoCount: 1,
      scannedRepoCount: 0,
      totalWorktreeCount: 2,
      scannedWorktreeCount: 1,
      currentRepoDisplayName: 'orca',
      currentWorktreeDisplayName: 'feature'
    }
    onProgress?.(progress)
    await promise

    expect(event.sender.send).toHaveBeenCalledWith('workspaceSpace:progress', progress)
  })

  it('batches completed measurements without dropping throttled rows', async () => {
    const store = createStore()
    let onProgress: ((progress: WorkspaceSpaceScanProgress) => void) | undefined
    let resolveScan!: (analysis: WorkspaceSpaceAnalysis) => void
    analyzeWorkspaceSpaceMock.mockImplementationOnce((_store, options) => {
      onProgress = options.onProgress
      return new Promise<WorkspaceSpaceAnalysis>((resolve) => {
        resolveScan = resolve
      })
    })
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)

    try {
      registerWorkspaceSpaceHandlers(store)
      const event = createEvent()
      const promise = handlers.get('workspaceSpace:analyze')!(event)
      const base = {
        scanId: 'scan-1',
        state: 'running' as const,
        startedAt: 1,
        updatedAt: 1,
        totalRepoCount: 1,
        scannedRepoCount: 0,
        totalWorktreeCount: 2,
        currentRepoDisplayName: 'orca',
        currentWorktreeDisplayName: 'feature'
      }
      onProgress?.({ ...base, scannedWorktreeCount: 0 })
      onProgress?.({
        ...base,
        scannedWorktreeCount: 1,
        completedMeasurements: [{ worktreeId: 'a', status: 'ok', sizeBytes: 10 }]
      })
      onProgress?.({
        ...base,
        scannedWorktreeCount: 2,
        completedMeasurements: [{ worktreeId: 'b', status: 'ok', sizeBytes: 20 }]
      })
      resolveScan(createAnalysis(1))
      await promise

      expect(event.sender.send).toHaveBeenCalledTimes(2)
      expect(event.sender.send).toHaveBeenLastCalledWith(
        'workspaceSpace:progress',
        expect.objectContaining({
          scannedWorktreeCount: 2,
          completedMeasurements: [
            { worktreeId: 'a', status: 'ok', sizeBytes: 10 },
            { worktreeId: 'b', status: 'ok', sizeBytes: 20 }
          ]
        })
      )
    } finally {
      now.mockRestore()
    }
  })

  it('cancels the in-flight scan', async () => {
    const store = createStore()
    let signal: AbortSignal | undefined
    analyzeWorkspaceSpaceMock.mockImplementationOnce((_store, options) => {
      signal = options.signal
      return new Promise<WorkspaceSpaceAnalysis>(() => {})
    })

    registerWorkspaceSpaceHandlers(store)
    const analyzeHandler = handlers.get('workspaceSpace:analyze')
    const cancelHandler = handlers.get('workspaceSpace:cancel')
    void analyzeHandler!(createEvent())

    await expect(cancelHandler!()).resolves.toBe(true)
    expect(signal?.aborted).toBe(true)
    await expect(cancelHandler!()).resolves.toBe(false)
  })

  it('returns a normal cancelled result instead of rejecting expected cancellation', async () => {
    const store = createStore()
    analyzeWorkspaceSpaceMock.mockRejectedValueOnce(new WorkspaceSpaceScanCancelledErrorMock())

    registerWorkspaceSpaceHandlers(store)
    const analyzeHandler = handlers.get('workspaceSpace:analyze')

    await expect(analyzeHandler!(createEvent())).resolves.toEqual({ ok: false, cancelled: true })
    expect(persistAnalysisSnapshotMock).not.toHaveBeenCalled()
  })

  it('persists the completed analysis snapshot', async () => {
    const analysis = createAnalysis(7)
    analyzeWorkspaceSpaceMock.mockResolvedValueOnce(analysis)

    registerWorkspaceSpaceHandlers(createStore())
    const analyzeHandler = handlers.get('workspaceSpace:analyze')

    await expect(analyzeHandler!(createEvent())).resolves.toEqual({ ok: true, analysis })
    expect(persistAnalysisSnapshotMock).toHaveBeenCalledWith('/profile-a', analysis)
  })

  it('serves the cached analysis through getCachedAnalysis', async () => {
    const cached = createAnalysis(3)
    readAnalysisSnapshotMock.mockResolvedValue(cached)

    registerWorkspaceSpaceHandlers(createStore())
    expect(removeHandlerMock).toHaveBeenCalledWith('workspaceSpace:getCachedAnalysis')
    const cachedHandler = handlers.get('workspaceSpace:getCachedAnalysis')

    await expect(cachedHandler!()).resolves.toBe(cached)
    expect(readAnalysisSnapshotMock).toHaveBeenCalledWith('/profile-a')
  })
})
