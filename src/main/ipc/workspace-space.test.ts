import { describe, expect, it, vi } from 'vitest'
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

describe('registerWorkspaceSpaceHandlers', () => {
  it('shares an in-flight analysis request', async () => {
    const store = {} as Store
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
    const store = {} as Store
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

  it('cancels the in-flight scan', async () => {
    const store = {} as Store
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
    const store = {} as Store
    analyzeWorkspaceSpaceMock.mockRejectedValueOnce(new WorkspaceSpaceScanCancelledErrorMock())

    registerWorkspaceSpaceHandlers(store)
    const analyzeHandler = handlers.get('workspaceSpace:analyze')

    await expect(analyzeHandler!(createEvent())).resolves.toEqual({ ok: false, cancelled: true })
  })
})
