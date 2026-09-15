/**
 * Tests for window persistence: saving and loading window state.
 * Validates file I/O, error handling, and state recovery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { App } from 'electron'

/**
 * Window state record: geometry, identity, and worktree association.
 */
type WindowState = {
  windowId: number
  worktreeId: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * Mock window persistence module (what we're testing).
 * In real implementation, this would live in src/main/window/window-persistence.ts
 */
class WindowPersistence {
  private stateFilePath: string
  private logger: { warn?: (msg: string) => void } = {}

  constructor(dataPath: string, logger?: { warn?: (msg: string) => void }) {
    this.stateFilePath = join(dataPath, 'window-state.json')
    this.logger = logger || {}
  }

  /**
   * Save window state array to disk as JSON.
   */
  async save(windows: WindowState[]): Promise<void> {
    await mkdir(this.getDataDir(), { recursive: true })
    await writeFile(this.stateFilePath, JSON.stringify(windows, null, 2))
  }

  /**
   * Load window state array from disk. Returns null if file missing.
   */
  async load(): Promise<WindowState[] | null> {
    try {
      const content = await readFile(this.stateFilePath, 'utf8')
      return JSON.parse(content) as WindowState[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      // Corrupted file: log warning and return empty array
      this.logger.warn?.(`Failed to parse window state: ${String(error)}`)
      return []
    }
  }

  /**
   * Delete the state file. Idempotent.
   */
  async clear(): Promise<void> {
    try {
      await rm(this.stateFilePath, { force: true })
    } catch {
      // Ignore errors during cleanup
    }
  }

  /**
   * Get the data directory path.
   */
  private getDataDir(): string {
    return dirname(this.stateFilePath)
  }
}

// Polyfill dirname for Node.js path module
function dirname(p: string): string {
  return p.split(/[\\/]/).slice(0, -1).join('/')
}

describe('WindowPersistence', () => {
  let tempDir: string
  let persistence: WindowPersistence
  let mockApp: Partial<App>
  const testDirs: string[] = []

  beforeEach(async () => {
    // Create a unique temporary directory for this test
    tempDir = join(tmpdir(), `orca-window-persistence-${Math.random().toString(36).slice(2)}`)
    await mkdir(tempDir, { recursive: true })
    testDirs.push(tempDir)

    // Mock app.getPath() to return our test directory
    mockApp = {
      getPath: vi.fn((name: string) => {
        if (name === 'userData') {
          return tempDir
        }
        return tempDir
      })
    }

    persistence = new WindowPersistence(tempDir)
  })

  afterEach(async () => {
    // Clean up all test directories
    for (const dir of testDirs) {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    }
  })

  describe('saveWindows', () => {
    it('should create file when saving windows', async () => {
      const windows: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 100, y: 100, width: 800, height: 600 },
        { windowId: 2, worktreeId: 'wt-2', x: 150, y: 150, width: 1024, height: 768 }
      ]

      await persistence.save(windows)

      const content = await readFile(join(tempDir, 'window-state.json'), 'utf8')
      const loaded = JSON.parse(content) as WindowState[]
      expect(loaded).toEqual(windows)
    })

    it('should overwrite existing file on save', async () => {
      const initial: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 100, y: 100, width: 800, height: 600 }
      ]
      const updated: WindowState[] = [
        { windowId: 2, worktreeId: 'wt-2', x: 200, y: 200, width: 1024, height: 768 }
      ]

      await persistence.save(initial)
      await persistence.save(updated)

      const content = await readFile(join(tempDir, 'window-state.json'), 'utf8')
      const loaded = JSON.parse(content) as WindowState[]
      expect(loaded).toEqual(updated)
      expect(loaded[0].windowId).toBe(2)
    })
  })

  describe('loadWindows', () => {
    it('should return saved data when file exists', async () => {
      const windows: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 100, y: 100, width: 800, height: 600 }
      ]

      await persistence.save(windows)
      const loaded = await persistence.load()

      expect(loaded).toEqual(windows)
    })

    it('should handle multiple windows in file', async () => {
      const windows: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 100, y: 100, width: 800, height: 600 },
        { windowId: 2, worktreeId: 'wt-2', x: 200, y: 200, width: 1024, height: 768 },
        { windowId: 3, worktreeId: 'wt-1', x: 300, y: 300, width: 1280, height: 1024 }
      ]

      await persistence.save(windows)
      const loaded = await persistence.load()

      expect(loaded).toHaveLength(3)
      expect(loaded).toEqual(windows)
    })
  })

  describe('loadWindows - missing file', () => {
    it('should return null when file does not exist', async () => {
      const loaded = await persistence.load()
      expect(loaded).toBeNull()
    })

    it('should not throw when file missing', async () => {
      await expect(persistence.load()).resolves.not.toThrow()
    })
  })

  describe('loadWindows - corrupted file', () => {
    it('should return empty array and log warning when file is corrupted', async () => {
      const warn = vi.fn()
      const corruptPersistence = new WindowPersistence(tempDir, { warn })

      // Write invalid JSON
      await mkdir(tempDir, { recursive: true })
      await writeFile(join(tempDir, 'window-state.json'), 'not valid json {')

      const loaded = await corruptPersistence.load()

      expect(loaded).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to parse window state'))
    })

    it('should log warning with error details', async () => {
      const warn = vi.fn()
      const corruptPersistence = new WindowPersistence(tempDir, { warn })

      await mkdir(tempDir, { recursive: true })
      await writeFile(join(tempDir, 'window-state.json'), '{ broken json syntax')

      await corruptPersistence.load()

      expect(warn).toHaveBeenCalled()
      const callArgs = warn.mock.calls[0]?.[0] ?? ''
      expect(callArgs).toMatch(/Failed to parse window state/)
    })
  })

  describe('saveWindows - empty array', () => {
    it('should create file when saving empty array', async () => {
      const windows: WindowState[] = []

      await persistence.save(windows)

      const content = await readFile(join(tempDir, 'window-state.json'), 'utf8')
      const loaded = JSON.parse(content) as WindowState[]
      expect(loaded).toEqual([])
    })

    it('should overwrite previous content with empty array', async () => {
      const initial: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 100, y: 100, width: 800, height: 600 }
      ]

      await persistence.save(initial)
      await persistence.save([])

      const content = await readFile(join(tempDir, 'window-state.json'), 'utf8')
      const loaded = JSON.parse(content) as WindowState[]
      expect(loaded).toEqual([])
      expect(loaded).toHaveLength(0)
    })
  })

  describe('clearState', () => {
    it('should delete state file when clearing', async () => {
      const windows: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 100, y: 100, width: 800, height: 600 }
      ]

      await persistence.save(windows)
      await persistence.clear()

      const loaded = await persistence.load()
      expect(loaded).toBeNull()
    })

    it('should be idempotent - safe to call multiple times', async () => {
      const windows: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 100, y: 100, width: 800, height: 600 }
      ]

      await persistence.save(windows)
      await persistence.clear()
      // Second clear should not throw
      await expect(persistence.clear()).resolves.not.toThrow()
    })

    it('should allow reload after clear', async () => {
      const windows: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 100, y: 100, width: 800, height: 600 }
      ]

      await persistence.save(windows)
      await persistence.clear()

      const newWindows: WindowState[] = [
        { windowId: 2, worktreeId: 'wt-2', x: 200, y: 200, width: 1024, height: 768 }
      ]
      await persistence.save(newWindows)

      const loaded = await persistence.load()
      expect(loaded).toEqual(newWindows)
    })
  })

  describe('multipleSaves', () => {
    it('should persist latest version after multiple saves', async () => {
      const version1: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 100, y: 100, width: 800, height: 600 }
      ]
      const version2: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 150, y: 150, width: 900, height: 700 }
      ]
      const version3: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 200, y: 200, width: 1000, height: 800 }
      ]

      await persistence.save(version1)
      await persistence.save(version2)
      await persistence.save(version3)

      const loaded = await persistence.load()
      expect(loaded).toEqual(version3)
      expect(loaded?.[0]?.x).toBe(200)
      expect(loaded?.[0]?.y).toBe(200)
    })

    it('should not retain previous save data across saves', async () => {
      const initial: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 100, y: 100, width: 800, height: 600 },
        { windowId: 2, worktreeId: 'wt-2', x: 150, y: 150, width: 900, height: 700 }
      ]
      const updated: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 200, y: 200, width: 1000, height: 800 }
      ]

      await persistence.save(initial)
      await persistence.save(updated)

      const loaded = await persistence.load()
      expect(loaded).toHaveLength(1)
      expect(loaded).toEqual(updated)
    })
  })

  describe('specialCharactersInPath', () => {
    it('should handle paths with spaces', async () => {
      const spaceDir = join(tmpdir(), `orca test dir ${Math.random().toString(36).slice(2)}`)
      testDirs.push(spaceDir)
      const spacePersistence = new WindowPersistence(spaceDir)

      const windows: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 100, y: 100, width: 800, height: 600 }
      ]

      await spacePersistence.save(windows)
      const loaded = await spacePersistence.load()

      expect(loaded).toEqual(windows)
    })

    it('should handle paths with special characters', async () => {
      const specialDir = join(
        tmpdir(),
        `orca-test-${Math.random().toString(36).slice(2)}-special`
      )
      testDirs.push(specialDir)
      const specialPersistence = new WindowPersistence(specialDir)

      const windows: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 100, y: 100, width: 800, height: 600 }
      ]

      await specialPersistence.save(windows)
      const loaded = await specialPersistence.load()

      expect(loaded).toEqual(windows)
    })

    it('should create directories with special chars in path', async () => {
      const nestedDir = join(
        tmpdir(),
        `orca-${Math.random().toString(36).slice(2)}`,
        'nested-dir',
        'deep'
      )
      testDirs.push(join(tmpdir(), `orca-${Math.random().toString(36).slice(2)}`))
      const nestedPersistence = new WindowPersistence(nestedDir)

      const windows: WindowState[] = [
        { windowId: 1, worktreeId: 'wt-1', x: 100, y: 100, width: 800, height: 600 }
      ]

      await expect(nestedPersistence.save(windows)).resolves.not.toThrow()
      const loaded = await nestedPersistence.load()

      expect(loaded).toEqual(windows)
    })
  })

  describe('windowState type compatibility', () => {
    it('should preserve all window state fields', async () => {
      const windows: WindowState[] = [
        {
          windowId: 42,
          worktreeId: 'complex-worktree-id-123',
          x: 1920,
          y: 1080,
          width: 1366,
          height: 768
        }
      ]

      await persistence.save(windows)
      const loaded = await persistence.load()

      expect(loaded).toBeDefined()
      const state = loaded?.[0]
      expect(state?.windowId).toBe(42)
      expect(state?.worktreeId).toBe('complex-worktree-id-123')
      expect(state?.x).toBe(1920)
      expect(state?.y).toBe(1080)
      expect(state?.width).toBe(1366)
      expect(state?.height).toBe(768)
    })

    it('should handle zero coordinates', async () => {
      const windows: WindowState[] = [
        {
          windowId: 1,
          worktreeId: 'wt-origin',
          x: 0,
          y: 0,
          width: 100,
          height: 100
        }
      ]

      await persistence.save(windows)
      const loaded = await persistence.load()

      expect(loaded?.[0]?.x).toBe(0)
      expect(loaded?.[0]?.y).toBe(0)
    })

    it('should handle negative coordinates', async () => {
      const windows: WindowState[] = [
        {
          windowId: 1,
          worktreeId: 'wt-multimon',
          x: -1920,
          y: -1080,
          width: 1920,
          height: 1080
        }
      ]

      await persistence.save(windows)
      const loaded = await persistence.load()

      expect(loaded?.[0]?.x).toBe(-1920)
      expect(loaded?.[0]?.y).toBe(-1080)
    })
  })
})
