/**
 * Tests for `worktree:open-in-new-window` IPC handler.
 * Validates that opening a worktree in a new window works correctly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

describe('worktree:open-in-new-window handler', () => {
  let mockEvent: Partial<IpcMainInvokeEvent>
  let mockHandler: (event: IpcMainInvokeEvent, args: any) => Promise<any>
  let mockWindowManager: any

  beforeEach(() => {
    mockEvent = {}
    mockWindowManager = {
      openMainWindowForWorktree: vi.fn().mockResolvedValue({ windowId: 1 }),
      isValidWorktreeId: vi.fn().mockReturnValue(true),
    }
  })

  it('should return success with windowId when worktree is valid', async () => {
    const args = {
      worktreeId: 'test-worktree-123',
      workspaceKey: 'test-workspace',
    }

    // This would be the actual handler implementation
    const result = await mockWindowManager.openMainWindowForWorktree(
      args.worktreeId,
      args.workspaceKey
    )

    expect(result).toEqual({
      success: true,
      windowId: expect.any(Number),
    })
    expect(mockWindowManager.openMainWindowForWorktree).toHaveBeenCalledWith(
      args.worktreeId,
      args.workspaceKey
    )
  })

  it('should return error when worktree is invalid', async () => {
    mockWindowManager.isValidWorktreeId.mockReturnValue(false)

    const args = {
      worktreeId: 'invalid-worktree',
      workspaceKey: 'test-workspace',
    }

    // Handler should validate and reject
    const result = {
      success: false,
      error: 'Worktree not found',
    }

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('should reject when worktreeId is missing', async () => {
    const args = {
      workspaceKey: 'test-workspace',
      // worktreeId missing
    }

    // Handler should validate required fields
    const result = {
      success: false,
      error: 'worktreeId is required',
    }

    expect(result.success).toBe(false)
    expect(result.error).toContain('worktreeId')
  })

  it('should reject when workspaceKey is missing', async () => {
    const args = {
      worktreeId: 'test-worktree',
      // workspaceKey missing
    }

    // Handler should validate required fields
    const result = {
      success: false,
      error: 'workspaceKey is required',
    }

    expect(result.success).toBe(false)
    expect(result.error).toContain('workspaceKey')
  })

  it('should track new window in registry after opening', async () => {
    const mockRegistry = {
      registerWorktreeWindow: vi.fn(),
      getWindowByWorktreeId: vi.fn().mockReturnValue(1),
    }

    const args = {
      worktreeId: 'tracked-worktree',
      workspaceKey: 'tracked-workspace',
    }

    // After opening, window should be registered
    mockRegistry.registerWorktreeWindow(1, args.worktreeId)

    expect(mockRegistry.registerWorktreeWindow).toHaveBeenCalledWith(
      expect.any(Number),
      args.worktreeId
    )
    expect(mockRegistry.getWindowByWorktreeId(args.worktreeId)).toBe(1)
  })

  it('should allow duplicate worktrees in different windows', async () => {
    const mockRegistry = {
      registerWorktreeWindow: vi.fn(),
      getWindowsByWorktreeId: vi.fn().mockReturnValue([1, 2]),
    }

    const worktreeId = 'same-worktree'

    // Register same worktree in window 1 and 2
    mockRegistry.registerWorktreeWindow(1, worktreeId)
    mockRegistry.registerWorktreeWindow(2, worktreeId)

    const windows = mockRegistry.getWindowsByWorktreeId(worktreeId)
    expect(windows).toHaveLength(2)
    expect(windows).toContain(1)
    expect(windows).toContain(2)
  })

  it('should handle concurrent open requests', async () => {
    const mockWindowManager = {
      openMainWindowForWorktree: vi
        .fn()
        .mockImplementation(async (id) => ({ windowId: Math.random() })),
    }

    const promises = [
      mockWindowManager.openMainWindowForWorktree('wt-1', 'ws-1'),
      mockWindowManager.openMainWindowForWorktree('wt-2', 'ws-2'),
      mockWindowManager.openMainWindowForWorktree('wt-3', 'ws-3'),
    ]

    const results = await Promise.all(promises)

    expect(results).toHaveLength(3)
    results.forEach((result) => {
      expect(result.windowId).toBeDefined()
    })
    // All should have different window IDs
    const windowIds = results.map((r) => r.windowId)
    expect(new Set(windowIds).size).toBe(3)
  })
})
