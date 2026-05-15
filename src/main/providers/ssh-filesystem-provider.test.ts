/* eslint-disable max-lines -- Why: SSH filesystem provider coverage keeps relay fallback,
SFTP binary writes, watch fan-out, and provider lifecycle tests together so
transport parity regressions are visible in one suite. */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshFilesystemProvider } from './ssh-filesystem-provider'

type MockMultiplexer = {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  onNotificationByMethod: ReturnType<typeof vi.fn>
  onDispose: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
  _methodHandlers: Map<string, Set<(params: Record<string, unknown>) => void>>
  _emitMethod: (method: string, params: Record<string, unknown>) => void
}

function createMockMux(): MockMultiplexer {
  const methodHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  return {
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    onNotification: vi.fn(),
    onNotificationByMethod: vi.fn(
      (method: string, handler: (params: Record<string, unknown>) => void) => {
        let set = methodHandlers.get(method)
        if (!set) {
          set = new Set()
          methodHandlers.set(method, set)
        }
        set.add(handler)
        return () => set!.delete(handler)
      }
    ),
    onDispose: vi.fn(() => () => {}),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false),
    _methodHandlers: methodHandlers,
    _emitMethod: (method, params) => {
      const set = methodHandlers.get(method)
      if (set) {
        for (const handler of Array.from(set)) {
          handler(params)
        }
      }
    }
  }
}

describe('SshFilesystemProvider', () => {
  let mux: MockMultiplexer
  let provider: SshFilesystemProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshFilesystemProvider('conn-1', mux as never)
  })

  it('returns the connectionId', () => {
    expect(provider.getConnectionId()).toBe('conn-1')
  })

  describe('readDir', () => {
    it('sends fs.readDir request', async () => {
      const entries = [
        { name: 'src', isDirectory: true, isSymlink: false },
        { name: 'README.md', isDirectory: false, isSymlink: false }
      ]
      mux.request.mockResolvedValue(entries)

      const result = await provider.readDir('/home/user/project')
      expect(mux.request).toHaveBeenCalledWith('fs.readDir', { dirPath: '/home/user/project' })
      expect(result).toEqual(entries)
    })
  })

  describe('readFile', () => {
    it('short-circuits on empty:true metadata without subscribing to chunks', async () => {
      mux.request.mockResolvedValue({ totalSize: 0, isBinary: false, empty: true })
      const result = await provider.readFile('/home/user/empty.txt')
      expect(result).toEqual({ content: '', isBinary: false })
    })
  })

  describe('writeFile', () => {
    it('sends fs.writeFile request', async () => {
      await provider.writeFile('/home/user/file.txt', 'new content')
      expect(mux.request).toHaveBeenCalledWith('fs.writeFile', {
        filePath: '/home/user/file.txt',
        content: 'new content'
      })
    })
  })

  describe('writeFileBase64', () => {
    it('writes decoded bytes through SFTP', async () => {
      const written: Buffer[] = []
      const writeStream = {
        on: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => writeStream),
        end: vi.fn((buffer: Buffer) => {
          written.push(buffer)
          const closeHandler = writeStream.on.mock.calls.find(([event]) => event === 'close')?.[1]
          closeHandler?.()
        }),
        destroy: vi.fn()
      }
      const sftp = {
        createWriteStream: vi.fn(() => writeStream),
        end: vi.fn()
      }
      provider = new SshFilesystemProvider('conn-1', mux as never, async () => sftp as never)

      await provider.writeFileBase64('/home/user/logo.png', 'cG5n')

      expect(sftp.createWriteStream).toHaveBeenCalledWith('/home/user/logo.png', { flags: 'wx' })
      expect(written).toEqual([Buffer.from('png')])
      expect(sftp.end).toHaveBeenCalled()
      expect(mux.request).not.toHaveBeenCalledWith('fs.writeFile', expect.anything())
    })

    it('can append decoded chunks through SFTP', async () => {
      const writeStream = {
        on: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => writeStream),
        end: vi.fn((_buffer: Buffer) => {
          const closeHandler = writeStream.on.mock.calls.find(([event]) => event === 'close')?.[1]
          closeHandler?.()
        }),
        destroy: vi.fn()
      }
      const sftp = {
        createWriteStream: vi.fn(() => writeStream),
        end: vi.fn()
      }
      provider = new SshFilesystemProvider('conn-1', mux as never, async () => sftp as never)

      await provider.writeFileBase64Chunk('/home/user/logo.png', 'cG5n', true)

      expect(sftp.createWriteStream).toHaveBeenCalledWith('/home/user/logo.png', { flags: 'a' })
      expect(sftp.end).toHaveBeenCalled()
    })
  })

  describe('createDirNoClobber', () => {
    it('sends fs.createDirNoClobber request', async () => {
      await provider.createDirNoClobber('/home/user/new-dir')

      expect(mux.request).toHaveBeenCalledWith('fs.createDirNoClobber', {
        dirPath: '/home/user/new-dir'
      })
    })
  })

  describe('stat', () => {
    it('sends fs.stat request', async () => {
      const statResult = { size: 1024, type: 'file', mtime: 1234567890 }
      mux.request.mockResolvedValue(statResult)

      const result = await provider.stat('/home/user/file.txt')
      expect(mux.request).toHaveBeenCalledWith('fs.stat', { filePath: '/home/user/file.txt' })
      expect(result).toEqual(statResult)
    })
  })

  it('scanWorkspaceSpace sends an abortable bulk scan request', async () => {
    const result = {
      sizeBytes: 1024,
      skippedEntryCount: 0,
      topLevelItems: [],
      omittedTopLevelItemCount: 0,
      omittedTopLevelSizeBytes: 0
    }
    const controller = new AbortController()
    mux.request.mockResolvedValue(result)

    await expect(
      provider.scanWorkspaceSpace('/home/user/project', { signal: controller.signal })
    ).resolves.toBe(result)
    expect(mux.request).toHaveBeenCalledWith(
      'fs.workspaceSpaceScan',
      { rootPath: '/home/user/project' },
      { signal: controller.signal, timeoutMs: 130000 }
    )
  })

  it('deletePath sends fs.deletePath request', async () => {
    await provider.deletePath('/home/user/file.txt')
    expect(mux.request).toHaveBeenCalledWith('fs.deletePath', { targetPath: '/home/user/file.txt' })
  })

  it('createFile sends fs.createFile request', async () => {
    await provider.createFile('/home/user/new.txt')
    expect(mux.request).toHaveBeenCalledWith('fs.createFile', { filePath: '/home/user/new.txt' })
  })

  it('createDir sends fs.createDir request', async () => {
    await provider.createDir('/home/user/newdir')
    expect(mux.request).toHaveBeenCalledWith('fs.createDir', { dirPath: '/home/user/newdir' })
  })

  it('rename sends fs.rename request', async () => {
    await provider.rename('/home/old.txt', '/home/new.txt')
    expect(mux.request).toHaveBeenCalledWith('fs.rename', {
      oldPath: '/home/old.txt',
      newPath: '/home/new.txt'
    })
  })

  it('copy sends fs.copy request', async () => {
    await provider.copy('/home/src.txt', '/home/dst.txt')
    expect(mux.request).toHaveBeenCalledWith('fs.copy', {
      source: '/home/src.txt',
      destination: '/home/dst.txt'
    })
  })

  it('realpath sends fs.realpath request', async () => {
    mux.request.mockResolvedValue('/home/user/real/path')
    const result = await provider.realpath('/home/user/link')
    expect(result).toBe('/home/user/real/path')
  })

  it('search sends fs.search request with all options', async () => {
    const searchResult = { files: [], totalMatches: 0, truncated: false }
    mux.request.mockResolvedValue(searchResult)

    const opts = {
      query: 'TODO',
      rootPath: '/home/user/project',
      caseSensitive: true
    }
    const result = await provider.search(opts)
    expect(mux.request).toHaveBeenCalledWith('fs.search', opts)
    expect(result).toEqual(searchResult)
  })

  it('listFiles sends fs.listFiles request', async () => {
    mux.request.mockResolvedValue(['src/index.ts', 'package.json'])
    const result = await provider.listFiles('/home/user/project')
    expect(mux.request).toHaveBeenCalledWith('fs.listFiles', { rootPath: '/home/user/project' })
    expect(result).toEqual(['src/index.ts', 'package.json'])
  })

  it('listFiles forwards excludePaths when provided', async () => {
    mux.request.mockResolvedValue([])
    await provider.listFiles('/home/user/project', {
      excludePaths: ['/home/user/project/worktrees/b']
    })
    expect(mux.request).toHaveBeenCalledWith('fs.listFiles', {
      rootPath: '/home/user/project',
      excludePaths: ['/home/user/project/worktrees/b']
    })
  })

  it('listFiles omits excludePaths when empty', async () => {
    mux.request.mockResolvedValue([])
    await provider.listFiles('/home/user/project', { excludePaths: [] })
    expect(mux.request).toHaveBeenCalledWith('fs.listFiles', { rootPath: '/home/user/project' })
  })

  describe('watch', () => {
    it('sends fs.watch request and returns unsubscribe', async () => {
      const callback = vi.fn()
      const unsub = await provider.watch('/home/user/project', callback)

      expect(mux.request).toHaveBeenCalledWith('fs.watch', { rootPath: '/home/user/project' })
      expect(typeof unsub).toBe('function')
    })

    it('forwards fs.changed notifications to watch callback', async () => {
      const callback = vi.fn()
      await provider.watch('/home/user/project', callback)

      const notifHandler = mux.onNotification.mock.calls[0][0]
      const events = [{ kind: 'update', absolutePath: '/home/user/project/file.ts' }]
      notifHandler('fs.changed', { events })

      expect(callback).toHaveBeenCalledWith(events)
    })

    it('fans out same-root watch events and unwatches only after the last subscriber', async () => {
      const first = vi.fn()
      const second = vi.fn()
      const unsubFirst = await provider.watch('/home/user/project', first)
      const unsubSecond = await provider.watch('/home/user/project', second)

      expect(mux.request).toHaveBeenCalledTimes(1)
      expect(mux.request).toHaveBeenCalledWith('fs.watch', { rootPath: '/home/user/project' })

      const notifHandler = mux.onNotification.mock.calls[0][0]
      const events = [{ kind: 'update', absolutePath: '/home/user/project/file.ts' }]
      notifHandler('fs.changed', { events })
      expect(first).toHaveBeenCalledWith(events)
      expect(second).toHaveBeenCalledWith(events)

      unsubFirst()
      expect(mux.notify).not.toHaveBeenCalledWith('fs.unwatch', { rootPath: '/home/user/project' })
      notifHandler('fs.changed', { events })
      expect(second).toHaveBeenCalledTimes(2)

      unsubSecond()
      expect(mux.notify).toHaveBeenCalledWith('fs.unwatch', { rootPath: '/home/user/project' })
    })

    it('shares an in-flight same-root watch setup across concurrent subscribers', async () => {
      let resolveWatch: () => void = () => {}
      mux.request.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveWatch = resolve
          })
      )
      const first = vi.fn()
      const second = vi.fn()

      const firstWatch = provider.watch('/home/user/project', first)
      const secondWatch = provider.watch('/home/user/project', second)

      expect(mux.request).toHaveBeenCalledTimes(1)
      resolveWatch()
      const [unsubFirst, unsubSecond] = await Promise.all([firstWatch, secondWatch])

      const notifHandler = mux.onNotification.mock.calls[0][0]
      const events = [{ kind: 'update', absolutePath: '/home/user/project/file.ts' }]
      notifHandler('fs.changed', { events })
      expect(first).toHaveBeenCalledWith(events)
      expect(second).toHaveBeenCalledWith(events)

      unsubFirst()
      expect(mux.notify).not.toHaveBeenCalledWith('fs.unwatch', { rootPath: '/home/user/project' })
      unsubSecond()
      expect(mux.notify).toHaveBeenCalledWith('fs.unwatch', { rootPath: '/home/user/project' })
    })

    it('does not retain a watch listener when fs.watch setup fails', async () => {
      mux.request.mockRejectedValueOnce(new Error('watch unavailable'))
      const first = vi.fn()
      await expect(provider.watch('/home/user/project', first)).rejects.toThrow('watch unavailable')

      const second = vi.fn()
      await provider.watch('/home/user/project', second)

      const notifHandler = mux.onNotification.mock.calls[0][0]
      const events = [{ kind: 'update', absolutePath: '/home/user/project/file.ts' }]
      notifHandler('fs.changed', { events })
      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledWith(events)
    })

    it('does not forward sibling paths with matching prefixes', async () => {
      const callback = vi.fn()
      await provider.watch('/home/user/project', callback)

      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('fs.changed', {
        events: [
          { kind: 'update', absolutePath: '/home/user/project-old/file.ts' },
          { kind: 'update', absolutePath: '/home/user/project2/file.ts' }
        ]
      })

      expect(callback).not.toHaveBeenCalled()
    })

    it('matches Windows and UNC watch roots case-insensitively', async () => {
      const driveCallback = vi.fn()
      const uncCallback = vi.fn()
      await provider.watch('C:\\Repo', driveCallback)
      await provider.watch('//Server/Share/Repo', uncCallback)

      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('fs.changed', {
        events: [
          { kind: 'update', absolutePath: 'c:\\repo\\src\\file.ts' },
          { kind: 'update', absolutePath: '//server/share/repo/docs/readme.md' }
        ]
      })

      expect(driveCallback).toHaveBeenCalledWith([
        { kind: 'update', absolutePath: 'c:\\repo\\src\\file.ts' }
      ])
      expect(uncCallback).toHaveBeenCalledWith([
        { kind: 'update', absolutePath: '//server/share/repo/docs/readme.md' }
      ])
    })

    it('sends fs.unwatch when last listener unsubscribes', async () => {
      const callback = vi.fn()
      const unsub = await provider.watch('/home/user/project', callback)
      unsub()

      expect(mux.notify).toHaveBeenCalledWith('fs.unwatch', { rootPath: '/home/user/project' })
    })

    it('does not send fs.unwatch while other roots are watched', async () => {
      const cb1 = vi.fn()
      const cb2 = vi.fn()
      const unsub1 = await provider.watch('/home/user/project-a', cb1)
      await provider.watch('/home/user/project-b', cb2)

      unsub1()
      expect(mux.notify).not.toHaveBeenCalledWith('fs.unwatch', {
        rootPath: '/home/user/project-b'
      })
    })
  })
})
