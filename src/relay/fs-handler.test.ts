/* eslint-disable max-lines -- Why: this suite covers relay filesystem RPCs,
   Space scans, file watcher lifecycle edges, and cross-platform path behavior together. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { FsHandler } from './fs-handler'
import { RelayContext } from './context'
import type { RelayDispatcher } from './dispatcher'
import * as fs from 'fs/promises'
import * as path from 'path'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'

const { mockSubscribe } = vi.hoisted(() => ({
  mockSubscribe: vi.fn()
}))

vi.mock('@parcel/watcher', () => ({
  subscribe: mockSubscribe
}))

function createMockDispatcher() {
  const requestHandlers = new Map<
    string,
    (params: Record<string, unknown>, context?: { isStale: () => boolean }) => Promise<unknown>
  >()
  const notificationHandlers = new Map<string, (params: Record<string, unknown>) => void>()
  const notifications: { method: string; params?: Record<string, unknown> }[] = []

  return {
    onRequest: vi.fn(
      (
        method: string,
        handler: (
          params: Record<string, unknown>,
          context?: { isStale: () => boolean }
        ) => Promise<unknown>
      ) => {
        requestHandlers.set(method, handler)
      }
    ),
    onNotification: vi.fn((method: string, handler: (params: Record<string, unknown>) => void) => {
      notificationHandlers.set(method, handler)
    }),
    notify: vi.fn((method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params })
    }),
    _requestHandlers: requestHandlers,
    _notificationHandlers: notificationHandlers,
    _notifications: notifications,
    async callRequest(
      method: string,
      params: Record<string, unknown> = {},
      context?: { isStale: () => boolean }
    ) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      return handler(params, context)
    },
    callNotification(method: string, params: Record<string, unknown> = {}) {
      const handler = notificationHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      handler(params)
    }
  }
}

describe('FsHandler', () => {
  let dispatcher: ReturnType<typeof createMockDispatcher>
  let handler: FsHandler
  let tmpDir: string

  beforeEach(() => {
    mockSubscribe.mockReset()
    mockSubscribe.mockResolvedValue({ unsubscribe: vi.fn() })
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-fs-'))
    dispatcher = createMockDispatcher()
    const ctx = new RelayContext()
    handler = new FsHandler(dispatcher as unknown as RelayDispatcher, ctx)
  })

  afterEach(async () => {
    handler.dispose()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('registers all expected handlers', () => {
    const methods = Array.from(dispatcher._requestHandlers.keys())
    expect(methods).toContain('fs.readDir')
    expect(methods).toContain('fs.readFile')
    expect(methods).toContain('fs.writeFile')
    expect(methods).toContain('fs.stat')
    expect(methods).toContain('fs.deletePath')
    expect(methods).toContain('fs.createFile')
    expect(methods).toContain('fs.createDir')
    expect(methods).toContain('fs.createDirNoClobber')
    expect(methods).toContain('fs.rename')
    expect(methods).toContain('fs.copy')
    expect(methods).toContain('fs.realpath')
    expect(methods).toContain('fs.search')
    expect(methods).toContain('fs.listFiles')
    expect(methods).toContain('fs.workspaceSpaceScan')
    expect(methods).toContain('fs.watch')

    const notifMethods = Array.from(dispatcher._notificationHandlers.keys())
    expect(notifMethods).toContain('fs.unwatch')
  })

  it('readDir returns sorted entries with directories first', async () => {
    mkdirSync(path.join(tmpDir, 'subdir'))
    writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
    writeFileSync(path.join(tmpDir, 'aaa.txt'), 'world')

    const result = (await dispatcher.callRequest('fs.readDir', { dirPath: tmpDir })) as {
      name: string
      isDirectory: boolean
    }[]
    expect(result[0].name).toBe('subdir')
    expect(result[0].isDirectory).toBe(true)
    expect(result.find((e) => e.name === 'file.txt')).toBeDefined()
    expect(result.find((e) => e.name === 'aaa.txt')).toBeDefined()
  })

  it('readDir reports symlinked directories as directories', async () => {
    const targetDir = path.join(tmpDir, 'external-models')
    const linkPath = path.join(tmpDir, 'Model')
    mkdirSync(targetDir)
    symlinkSync(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

    const result = (await dispatcher.callRequest('fs.readDir', { dirPath: tmpDir })) as {
      name: string
      isDirectory: boolean
      isSymlink: boolean
    }[]

    expect(result.find((e) => e.name === 'Model')).toEqual({
      name: 'Model',
      isDirectory: true,
      isSymlink: true
    })
  })

  it('readFile returns text content for text files', async () => {
    const filePath = path.join(tmpDir, 'test.txt')
    writeFileSync(filePath, 'hello world')

    const result = (await dispatcher.callRequest('fs.readFile', { filePath })) as {
      content: string
      isBinary: boolean
    }
    expect(result.content).toBe('hello world')
    expect(result.isBinary).toBe(false)
  })

  it('readFile returns text files larger than the old 5MB guard', async () => {
    const filePath = path.join(tmpDir, 'large.json')
    const content = 'a'.repeat(6 * 1024 * 1024)
    writeFileSync(filePath, content)

    const result = (await dispatcher.callRequest('fs.readFile', { filePath })) as {
      content: string
      isBinary: boolean
    }
    expect(result.content).toBe(content)
    expect(result.isBinary).toBe(false)
  })

  it('readFile returns binary marker for large unknown binary files', async () => {
    const filePath = path.join(tmpDir, 'archive.bin')
    const content = Buffer.alloc(6 * 1024 * 1024, 0x61)
    content[0] = 0x00
    writeFileSync(filePath, content)

    const result = (await dispatcher.callRequest('fs.readFile', { filePath })) as {
      content: string
      isBinary: boolean
    }
    expect(result.content).toBe('')
    expect(result.isBinary).toBe(true)
  })

  it('readFile returns base64 for image files', async () => {
    const filePath = path.join(tmpDir, 'test.png')
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = (await dispatcher.callRequest('fs.readFile', { filePath })) as {
      content: string
      isBinary: boolean
      isImage: boolean
      mimeType: string
    }
    expect(result.isBinary).toBe(true)
    expect(result.isImage).toBe(true)
    expect(result.mimeType).toBe('image/png')
    expect(result.content).toBeTruthy()
  })

  it('readFile throws for files exceeding size limit', async () => {
    const filePath = path.join(tmpDir, 'huge.txt')
    writeFileSync(filePath, Buffer.alloc(11 * 1024 * 1024, 'a'))

    await expect(dispatcher.callRequest('fs.readFile', { filePath })).rejects.toThrow(
      'File too large'
    )
  })

  it('writeFile creates/overwrites file content', async () => {
    const filePath = path.join(tmpDir, 'write-test.txt')
    await dispatcher.callRequest('fs.writeFile', { filePath, content: 'new content' })

    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('new content')
  })

  it('stat returns file metadata', async () => {
    const filePath = path.join(tmpDir, 'stat-test.txt')
    writeFileSync(filePath, 'test')

    const result = (await dispatcher.callRequest('fs.stat', { filePath })) as {
      size: number
      type: string
      mtime: number
    }
    expect(result.type).toBe('file')
    expect(result.size).toBe(4)
    expect(typeof result.mtime).toBe('number')
  })

  it('stat returns directory type for directories', async () => {
    const result = (await dispatcher.callRequest('fs.stat', { filePath: tmpDir })) as {
      type: string
    }
    expect(result.type).toBe('directory')
  })

  it('stat returns directory type for symlinked directories', async () => {
    const targetDir = path.join(tmpDir, 'external-models')
    const linkPath = path.join(tmpDir, 'Model')
    mkdirSync(targetDir)
    symlinkSync(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

    const result = (await dispatcher.callRequest('fs.stat', { filePath: linkPath })) as {
      type: string
    }

    expect(result.type).toBe('directory')
  })

  it('workspaceSpaceScan returns bounded top-level size details', async () => {
    mkdirSync(path.join(tmpDir, 'node_modules'))
    writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), Buffer.alloc(512))
    writeFileSync(path.join(tmpDir, 'file.log'), Buffer.alloc(128))

    const result = (await dispatcher.callRequest(
      'fs.workspaceSpaceScan',
      { rootPath: tmpDir },
      { isStale: () => false }
    )) as {
      sizeBytes: number
      topLevelItems: { name: string; sizeBytes: number }[]
    }

    expect(result.sizeBytes).toBeGreaterThanOrEqual(640)
    expect(result.topLevelItems.map((item) => item.name)).toContain('node_modules')
    expect(result.topLevelItems.map((item) => item.name)).toContain('file.log')
  })

  it('deletePath removes files', async () => {
    const filePath = path.join(tmpDir, 'to-delete.txt')
    writeFileSync(filePath, 'bye')

    await dispatcher.callRequest('fs.deletePath', { targetPath: filePath })
    await expect(fs.access(filePath)).rejects.toThrow()
  })

  it('createFile creates an empty file with parent dirs', async () => {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'file.txt')
    await dispatcher.callRequest('fs.createFile', { filePath })

    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('')
  })

  it('createDir creates directories recursively', async () => {
    const dirPath = path.join(tmpDir, 'a', 'b', 'c')
    await dispatcher.callRequest('fs.createDir', { dirPath })

    const stats = await fs.stat(dirPath)
    expect(stats.isDirectory()).toBe(true)
  })

  it('createDirNoClobber fails when the directory already exists', async () => {
    const dirPath = path.join(tmpDir, 'existing')
    mkdirSync(dirPath)

    await expect(dispatcher.callRequest('fs.createDirNoClobber', { dirPath })).rejects.toThrow()
  })

  it('rename moves files', async () => {
    const oldPath = path.join(tmpDir, 'old.txt')
    const newPath = path.join(tmpDir, 'new.txt')
    writeFileSync(oldPath, 'content')

    await dispatcher.callRequest('fs.rename', { oldPath, newPath })

    await expect(fs.access(oldPath)).rejects.toThrow()
    const content = await fs.readFile(newPath, 'utf-8')
    expect(content).toBe('content')
  })

  it('copy duplicates files', async () => {
    const src = path.join(tmpDir, 'src.txt')
    const dst = path.join(tmpDir, 'dst.txt')
    writeFileSync(src, 'original')

    await dispatcher.callRequest('fs.copy', { source: src, destination: dst })

    const content = await fs.readFile(dst, 'utf-8')
    expect(content).toBe('original')
  })

  it('copy does not overwrite an existing destination', async () => {
    const src = path.join(tmpDir, 'src.txt')
    const dst = path.join(tmpDir, 'dst.txt')
    writeFileSync(src, 'original')
    writeFileSync(dst, 'existing')

    await expect(
      dispatcher.callRequest('fs.copy', { source: src, destination: dst })
    ).rejects.toThrow('EEXIST')

    const content = await fs.readFile(dst, 'utf-8')
    expect(content).toBe('existing')
  })

  it('realpath resolves symlinks', async () => {
    const realFile = path.join(tmpDir, 'real.txt')
    const linkPath = path.join(tmpDir, 'link.txt')
    writeFileSync(realFile, 'real')
    symlinkSync(realFile, linkPath)

    const result = (await dispatcher.callRequest('fs.realpath', { filePath: linkPath })) as string
    // On macOS, /var is a symlink to /private/var, so resolve both to compare
    const { realpathSync } = await import('fs')
    expect(result).toBe(realpathSync(realFile))
  })

  it('does not let stale pending watch remove newer replacement watch', async () => {
    const firstUnsubscribe = vi.fn()
    const secondUnsubscribe = vi.fn()
    let resolveFirst!: () => void
    mockSubscribe
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = () => resolve({ unsubscribe: firstUnsubscribe })
        })
      )
      .mockResolvedValueOnce({ unsubscribe: secondUnsubscribe })

    const firstWatch = dispatcher.callRequest(
      'fs.watch',
      { rootPath: tmpDir },
      { isStale: () => true }
    )
    while (mockSubscribe.mock.calls.length === 0) {
      await Promise.resolve()
    }
    await dispatcher.callRequest('fs.watch', { rootPath: tmpDir }, { isStale: () => false })
    resolveFirst()
    await firstWatch

    expect(firstUnsubscribe).toHaveBeenCalled()
    expect(secondUnsubscribe).not.toHaveBeenCalled()
    dispatcher.callNotification('fs.unwatch', { rootPath: tmpDir })
    expect(secondUnsubscribe).toHaveBeenCalled()
  })

  it('unsubscribes an active stale watch before replacing it', async () => {
    const firstUnsubscribe = vi.fn()
    const secondUnsubscribe = vi.fn()
    mockSubscribe
      .mockResolvedValueOnce({ unsubscribe: firstUnsubscribe })
      .mockResolvedValueOnce({ unsubscribe: secondUnsubscribe })

    let stale = false
    await dispatcher.callRequest('fs.watch', { rootPath: tmpDir }, { isStale: () => stale })
    stale = true
    await dispatcher.callRequest('fs.watch', { rootPath: tmpDir }, { isStale: () => false })

    expect(firstUnsubscribe).toHaveBeenCalled()
    expect(secondUnsubscribe).not.toHaveBeenCalled()
    dispatcher.callNotification('fs.unwatch', { rootPath: tmpDir })
    expect(secondUnsubscribe).toHaveBeenCalled()
  })

  it('replaces a stale watch for the same root before enforcing the watch cap', async () => {
    const firstUnsubscribe = vi.fn()
    const replacementUnsubscribe = vi.fn()
    mockSubscribe
      .mockResolvedValueOnce({ unsubscribe: firstUnsubscribe })
      .mockResolvedValueOnce({ unsubscribe: replacementUnsubscribe })

    let stale = false
    await dispatcher.callRequest('fs.watch', { rootPath: tmpDir }, { isStale: () => stale })
    for (let index = 0; index < 19; index++) {
      await dispatcher.callRequest('fs.watch', {
        rootPath: path.join(tmpDir, `watched-${index}`)
      })
    }

    stale = true
    await dispatcher.callRequest('fs.watch', { rootPath: tmpDir }, { isStale: () => false })

    expect(firstUnsubscribe).toHaveBeenCalled()
    expect(replacementUnsubscribe).not.toHaveBeenCalled()
  })
})
