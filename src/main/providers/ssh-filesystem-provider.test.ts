import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshFilesystemProvider } from './ssh-filesystem-provider'

type MockMultiplexer = {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
}

function createMockMux(): MockMultiplexer {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
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
    it('sends fs.readFile request', async () => {
      const fileResult = { content: 'hello world', isBinary: false }
      mux.request.mockResolvedValue(fileResult)

      const result = await provider.readFile('/home/user/file.txt')
      expect(mux.request).toHaveBeenCalledWith('fs.readFile', { filePath: '/home/user/file.txt' })
      expect(result).toEqual(fileResult)
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

  describe('stat', () => {
    it('sends fs.stat request', async () => {
      const statResult = { size: 1024, type: 'file', mtime: 1234567890 }
      mux.request.mockResolvedValue(statResult)

      const result = await provider.stat('/home/user/file.txt')
      expect(mux.request).toHaveBeenCalledWith('fs.stat', { filePath: '/home/user/file.txt' })
      expect(result).toEqual(statResult)
    })
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
