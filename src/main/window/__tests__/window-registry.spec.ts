/**
 * Tests for WindowRegistry: tracking which windows belong to which worktrees.
 * Validates registration, deregistration, and query operations.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import WindowRegistry from '../window-registry'

describe('WindowRegistry', () => {
  let registry: WindowRegistry

  beforeEach(() => {
    registry = new WindowRegistry()
  })

  describe('register', () => {
    it('should register single window and verify stored', () => {
      registry.register(1, 'worktree-a')

      const worktree = registry.getWorktreesByWindowId(1)
      expect(worktree).toBe('worktree-a')
      expect(registry.getWindowCount()).toBe(1)
    })

    it('should register multiple windows with different worktrees', () => {
      registry.register(1, 'worktree-a')
      registry.register(2, 'worktree-b')
      registry.register(3, 'worktree-c')

      expect(registry.getWindowCount()).toBe(3)
      expect(registry.getWorktreesByWindowId(1)).toBe('worktree-a')
      expect(registry.getWorktreesByWindowId(2)).toBe('worktree-b')
      expect(registry.getWorktreesByWindowId(3)).toBe('worktree-c')
    })

    it('should allow same worktree in 2 windows and verify both tracked', () => {
      registry.register(1, 'shared-worktree')
      registry.register(2, 'shared-worktree')

      const windows = registry.getWindowsForWorktree('shared-worktree')
      expect(windows).toContain(1)
      expect(windows).toContain(2)
      expect(windows).toHaveLength(2)
    })
  })

  describe('deregister', () => {
    beforeEach(() => {
      registry.register(1, 'worktree-a')
      registry.register(2, 'worktree-b')
      registry.register(3, 'worktree-c')
    })

    it('should deregister window and verify removed', () => {
      expect(registry.getWorktreesByWindowId(1)).toBe('worktree-a')

      registry.deregister(1)

      expect(registry.getWorktreesByWindowId(1)).toBeUndefined()
      expect(registry.getWindowCount()).toBe(2)
    })

    it('should not affect other windows when deregistering one', () => {
      registry.deregister(1)

      expect(registry.getWorktreesByWindowId(2)).toBe('worktree-b')
      expect(registry.getWorktreesByWindowId(3)).toBe('worktree-c')
      expect(registry.getAllWindows()).toEqual([2, 3])
    })

    it('should handle deregister of non-existent window gracefully', () => {
      const countBefore = registry.getWindowCount()

      registry.deregister(999)

      expect(registry.getWindowCount()).toBe(countBefore)
      expect(registry.getAllWindows()).toEqual([1, 2, 3])
    })
  })

  describe('getWorktreesByWindowId', () => {
    it('should query window by worktreeId and return correct ID', () => {
      registry.register(1, 'target-worktree')
      registry.register(2, 'other-worktree')

      const worktree = registry.getWorktreesByWindowId(1)
      expect(worktree).toBe('target-worktree')
    })

    it('should return undefined when querying non-existent window', () => {
      registry.register(1, 'worktree-a')

      const worktree = registry.getWorktreesByWindowId(999)
      expect(worktree).toBeUndefined()
    })
  })

  describe('getWindowsForWorktree', () => {
    it('should query worktreeId by window and return correct windows', () => {
      registry.register(1, 'target-worktree')
      registry.register(2, 'target-worktree')
      registry.register(3, 'other-worktree')

      const windows = registry.getWindowsForWorktree('target-worktree')
      expect(windows).toContain(1)
      expect(windows).toContain(2)
      expect(windows).not.toContain(3)
    })

    it('should return empty array when querying non-existent worktree', () => {
      registry.register(1, 'worktree-a')

      const windows = registry.getWindowsForWorktree('nonexistent-worktree')
      expect(windows).toEqual([])
    })

    it('should allow same worktree in multiple windows and verify both queryable', () => {
      registry.register(10, 'shared-worktree')
      registry.register(20, 'shared-worktree')

      const windows = registry.getWindowsForWorktree('shared-worktree')
      expect(windows).toHaveLength(2)
      expect(windows).toEqual(expect.arrayContaining([10, 20]))

      // Verify both are still queryable
      expect(registry.getWorktreesByWindowId(10)).toBe('shared-worktree')
      expect(registry.getWorktreesByWindowId(20)).toBe('shared-worktree')
    })
  })

  describe('getAllWindows', () => {
    it('should return all registered windows', () => {
      registry.register(1, 'wt-a')
      registry.register(5, 'wt-b')
      registry.register(10, 'wt-c')

      const allWindows = registry.getAllWindows()
      expect(allWindows).toContain(1)
      expect(allWindows).toContain(5)
      expect(allWindows).toContain(10)
      expect(allWindows).toHaveLength(3)
    })

    it('should return empty array when no windows registered', () => {
      const allWindows = registry.getAllWindows()
      expect(allWindows).toEqual([])
    })
  })

  describe('getWindowCount', () => {
    it('should return correct count', () => {
      expect(registry.getWindowCount()).toBe(0)

      registry.register(1, 'wt-a')
      expect(registry.getWindowCount()).toBe(1)

      registry.register(2, 'wt-b')
      expect(registry.getWindowCount()).toBe(2)

      registry.deregister(1)
      expect(registry.getWindowCount()).toBe(1)
    })
  })

  describe('edge cases', () => {
    it('should handle re-registering same window with different worktree', () => {
      registry.register(1, 'old-worktree')
      expect(registry.getWorktreesByWindowId(1)).toBe('old-worktree')

      registry.register(1, 'new-worktree')
      expect(registry.getWorktreesByWindowId(1)).toBe('new-worktree')

      // Old worktree should have no windows
      expect(registry.getWindowsForWorktree('old-worktree')).toEqual([])
      // New worktree should have window 1
      expect(registry.getWindowsForWorktree('new-worktree')).toEqual([1])
    })

    it('should clean up worktree mapping when last window is deregistered', () => {
      registry.register(1, 'exclusive-worktree')
      registry.register(2, 'shared-worktree')
      registry.register(3, 'shared-worktree')

      // Deregister exclusive window
      registry.deregister(1)
      expect(registry.getWindowsForWorktree('exclusive-worktree')).toEqual([])

      // Deregister one shared window
      registry.deregister(2)
      expect(registry.getWindowsForWorktree('shared-worktree')).toEqual([3])

      // Deregister last shared window
      registry.deregister(3)
      expect(registry.getWindowsForWorktree('shared-worktree')).toEqual([])
    })
  })
})
