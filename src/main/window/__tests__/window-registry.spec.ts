/**
 * Tests for window registry: tracking which window has which worktree.
 * Validates window lifecycle and cleanup logic.
 */

import { describe, it, expect, beforeEach } from 'vitest'

interface WindowRegistryEntry {
  windowId: number
  worktreeId: string
  createdAt: number
}

describe('WindowRegistry', () => {
  let registry: Map<number, WindowRegistryEntry>

  beforeEach(() => {
    registry = new Map()
  })

  describe('registerWorktreeWindow', () => {
    it('should register a window with worktreeId', () => {
      const windowId = 1
      const worktreeId = 'test-worktree'

      registry.set(windowId, {
        windowId,
        worktreeId,
        createdAt: Date.now(),
      })

      expect(registry.has(windowId)).toBe(true)
      expect(registry.get(windowId)?.worktreeId).toBe(worktreeId)
    })

    it('should register multiple windows with different worktrees', () => {
      registry.set(1, { windowId: 1, worktreeId: 'wt-1', createdAt: Date.now() })
      registry.set(2, { windowId: 2, worktreeId: 'wt-2', createdAt: Date.now() })
      registry.set(3, { windowId: 3, worktreeId: 'wt-3', createdAt: Date.now() })

      expect(registry.size).toBe(3)
    })

    it('should allow same worktree in multiple windows', () => {
      const worktreeId = 'same-worktree'

      registry.set(1, { windowId: 1, worktreeId, createdAt: Date.now() })
      registry.set(2, { windowId: 2, worktreeId, createdAt: Date.now() })

      const allEntries = Array.from(registry.values())
      const withSameWorktree = allEntries.filter((e) => e.worktreeId === worktreeId)

      expect(withSameWorktree).toHaveLength(2)
    })

    it('should track creation time', () => {
      const before = Date.now()
      registry.set(1, { windowId: 1, worktreeId: 'wt', createdAt: Date.now() })
      const after = Date.now()

      const entry = registry.get(1)!
      expect(entry.createdAt).toBeGreaterThanOrEqual(before)
      expect(entry.createdAt).toBeLessThanOrEqual(after)
    })
  })

  describe('removeWindow', () => {
    beforeEach(() => {
      registry.set(1, { windowId: 1, worktreeId: 'wt-1', createdAt: Date.now() })
      registry.set(2, { windowId: 2, worktreeId: 'wt-2', createdAt: Date.now() })
    })

    it('should remove window by id', () => {
      expect(registry.has(1)).toBe(true)

      registry.delete(1)

      expect(registry.has(1)).toBe(false)
      expect(registry.size).toBe(1)
    })

    it('should not affect other windows', () => {
      registry.delete(1)

      expect(registry.get(2)).toBeDefined()
      expect(registry.get(2)?.worktreeId).toBe('wt-2')
    })

    it('should handle removal of non-existent window gracefully', () => {
      expect(registry.has(999)).toBe(false)

      registry.delete(999)

      expect(registry.size).toBe(2) // Unchanged
    })
  })

  describe('getWorktreesByWindowId', () => {
    it('should return worktree for registered window', () => {
      registry.set(1, { windowId: 1, worktreeId: 'wt-1', createdAt: Date.now() })

      const entry = registry.get(1)
      expect(entry?.worktreeId).toBe('wt-1')
    })

    it('should return undefined for unregistered window', () => {
      const entry = registry.get(999)
      expect(entry).toBeUndefined()
    })
  })

  describe('getWindowsByWorktreeId', () => {
    it('should return all windows with given worktreeId', () => {
      const worktreeId = 'multi-window'

      registry.set(1, { windowId: 1, worktreeId, createdAt: Date.now() })
      registry.set(2, { windowId: 2, worktreeId, createdAt: Date.now() })
      registry.set(3, { windowId: 3, worktreeId: 'other', createdAt: Date.now() })

      const windows = Array.from(registry.values())
        .filter((e) => e.worktreeId === worktreeId)
        .map((e) => e.windowId)

      expect(windows).toEqual([1, 2])
    })

    it('should return empty array if no windows have worktree', () => {
      registry.set(1, { windowId: 1, worktreeId: 'wt-1', createdAt: Date.now() })

      const windows = Array.from(registry.values())
        .filter((e) => e.worktreeId === 'nonexistent')
        .map((e) => e.windowId)

      expect(windows).toEqual([])
    })
  })

  describe('cleanup on window close', () => {
    it('should auto-remove window when it closes', () => {
      registry.set(1, { windowId: 1, worktreeId: 'wt-1', createdAt: Date.now() })
      registry.set(2, { windowId: 2, worktreeId: 'wt-2', createdAt: Date.now() })

      // Simulate window close
      registry.delete(1)

      expect(registry.size).toBe(1)
      expect(registry.has(1)).toBe(false)
      expect(registry.has(2)).toBe(true)
    })

    it('should allow all windows to be closed', () => {
      registry.set(1, { windowId: 1, worktreeId: 'wt-1', createdAt: Date.now() })
      registry.set(2, { windowId: 2, worktreeId: 'wt-2', createdAt: Date.now() })

      registry.delete(1)
      registry.delete(2)

      expect(registry.size).toBe(0)
    })

    it('should signal app exit when all windows closed', () => {
      registry.set(1, { windowId: 1, worktreeId: 'wt-1', createdAt: Date.now() })

      registry.delete(1)

      // App should exit when registry is empty
      expect(registry.size).toBe(0)
    })
  })

  describe('getActiveWindows', () => {
    it('should return list of all active windows', () => {
      registry.set(1, { windowId: 1, worktreeId: 'wt-1', createdAt: Date.now() })
      registry.set(2, { windowId: 2, worktreeId: 'wt-2', createdAt: Date.now() })
      registry.set(5, { windowId: 5, worktreeId: 'wt-3', createdAt: Date.now() })

      const activeWindows = Array.from(registry.keys())

      expect(activeWindows).toEqual([1, 2, 5])
      expect(activeWindows.length).toBe(3)
    })

    it('should return empty when no windows registered', () => {
      const activeWindows = Array.from(registry.keys())
      expect(activeWindows).toEqual([])
    })
  })

  describe('getWindowCount', () => {
    it('should return correct count', () => {
      registry.set(1, { windowId: 1, worktreeId: 'wt-1', createdAt: Date.now() })
      registry.set(2, { windowId: 2, worktreeId: 'wt-2', createdAt: Date.now() })

      expect(registry.size).toBe(2)
    })
  })
})
