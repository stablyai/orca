import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSpaceAnalysis } from '../../shared/workspace-space-types'
import type { Store } from '../persistence'

const { handlers, analyzeWorkspaceSpaceMock, removeHandlerMock, handleMock } = vi.hoisted(() => ({
  handlers: new Map<string, () => Promise<WorkspaceSpaceAnalysis>>(),
  analyzeWorkspaceSpaceMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  handleMock: vi.fn((channel: string, handler: () => Promise<WorkspaceSpaceAnalysis>) => {
    handlers.set(channel, handler)
  })
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock
  }
}))

vi.mock('../workspace-space-analysis', () => ({
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

    const first = handler!()
    const duplicate = handler!()
    expect(analyzeWorkspaceSpaceMock).toHaveBeenCalledTimes(1)
    expect(analyzeWorkspaceSpaceMock).toHaveBeenCalledWith(store)

    const firstResult = createAnalysis(1)
    resolveFirstScan(firstResult)
    await expect(first).resolves.toBe(firstResult)
    await expect(duplicate).resolves.toBe(firstResult)

    await expect(handler!()).resolves.toEqual(createAnalysis(2))
    expect(analyzeWorkspaceSpaceMock).toHaveBeenCalledTimes(2)
  })
})
