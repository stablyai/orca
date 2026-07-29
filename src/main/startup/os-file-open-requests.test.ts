import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import type { OsFileOpenApp } from './os-file-open-requests'
import {
  createOsFileOpenRequestQueue,
  extractMarkdownPathsFromArgv,
  filterExistingFiles,
  isMarkdownFilePath,
  registerOsFileOpenRequests
} from './os-file-open-requests'

describe('isMarkdownFilePath', () => {
  it('accepts absolute .md and .markdown paths regardless of case', () => {
    expect(isMarkdownFilePath('/Users/x/Downloads/note.md')).toBe(true)
    expect(isMarkdownFilePath('/Users/x/Downloads/NOTE.MD')).toBe(true)
    expect(isMarkdownFilePath('/Users/x/Downloads/note.markdown')).toBe(true)
  })

  it('rejects relative paths, other extensions, and extensionless names', () => {
    expect(isMarkdownFilePath('note.md')).toBe(false)
    expect(isMarkdownFilePath('/Users/x/Downloads/note.txt')).toBe(false)
    expect(isMarkdownFilePath('/Users/x/Downloads/note')).toBe(false)
  })
})

describe('extractMarkdownPathsFromArgv', () => {
  it('skips argv[0] and Chromium switches', () => {
    const argv = [
      '/Applications/Orca.app/Contents/MacOS/Orca',
      '--enable-features=Foo',
      '/Users/x/Downloads/a.md',
      '/Users/x/Downloads/b.txt',
      '/Users/x/Downloads/c.markdown'
    ]
    expect(extractMarkdownPathsFromArgv(argv)).toEqual([
      '/Users/x/Downloads/a.md',
      '/Users/x/Downloads/c.markdown'
    ])
  })

  it('does not treat an executable path ending in .md as an argument', () => {
    expect(extractMarkdownPathsFromArgv(['/tmp/weird.md'])).toEqual([])
  })
})

describe('createOsFileOpenRequestQueue', () => {
  it('buffers until a deliver target exists, then drains once', () => {
    const queue = createOsFileOpenRequestQueue()
    queue.enqueue('/Users/x/a.md')
    queue.enqueue('/Users/x/b.md')
    expect(queue.drain()).toEqual(['/Users/x/a.md', '/Users/x/b.md'])
    expect(queue.drain()).toEqual([])
  })

  it('drops non-markdown paths instead of queueing them', () => {
    const queue = createOsFileOpenRequestQueue()
    queue.enqueue('/Users/x/a.txt')
    expect(queue.drain()).toEqual([])
  })

  it('de-duplicates the same path while buffered', () => {
    const queue = createOsFileOpenRequestQueue()
    queue.enqueue('/Users/x/a.md')
    queue.enqueue('/Users/x/a.md')
    expect(queue.drain()).toEqual(['/Users/x/a.md'])
  })

  it('delivers immediately once a deliver target is set', () => {
    const queue = createOsFileOpenRequestQueue()
    const deliver = vi.fn()
    queue.setDeliver(deliver)
    queue.enqueue('/Users/x/a.md')
    expect(deliver).toHaveBeenCalledWith('/Users/x/a.md')
    expect(queue.drain()).toEqual([])
  })

  it('returns to buffering when the deliver target is cleared', () => {
    const queue = createOsFileOpenRequestQueue()
    const deliver = vi.fn()
    queue.setDeliver(deliver)
    queue.setDeliver(null)
    queue.enqueue('/Users/x/a.md')
    expect(deliver).not.toHaveBeenCalled()
    expect(queue.drain()).toEqual(['/Users/x/a.md'])
  })
})

describe('filterExistingFiles', () => {
  let tempDir: string
  let existingFile: string
  let directoryPath: string

  beforeAll(async () => {
    tempDir = join(tmpdir(), `orca-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tempDir, { recursive: true })
    existingFile = join(tempDir, 'test.md')
    await writeFile(existingFile, 'test content')
    directoryPath = join(tempDir, 'subdir')
    await mkdir(directoryPath)
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns existing files', async () => {
    const result = await filterExistingFiles([existingFile])
    expect(result).toEqual([existingFile])
  })

  it('filters out directories', async () => {
    const result = await filterExistingFiles([directoryPath])
    expect(result).toEqual([])
  })

  it('filters out missing paths without rejecting', async () => {
    const result = await filterExistingFiles(['/nonexistent/path/that/does/not/exist.md'])
    expect(result).toEqual([])
  })

  it('preserves input order for existing files', async () => {
    const file1 = join(tempDir, 'a.md')
    const file2 = join(tempDir, 'b.md')
    const file3 = join(tempDir, 'c.md')
    await writeFile(file1, 'a')
    await writeFile(file2, 'b')
    await writeFile(file3, 'c')

    const result = await filterExistingFiles([file3, file1, file2])
    expect(result).toEqual([file3, file1, file2])
  })

  it('filters mixed paths, keeping only existing files in order', async () => {
    const file1 = join(tempDir, 'x.md')
    const file2 = join(tempDir, 'y.md')
    await writeFile(file1, 'x')
    await writeFile(file2, 'y')

    const result = await filterExistingFiles([
      file1,
      '/nonexistent.md',
      directoryPath,
      file2,
      '/another/missing.md'
    ])
    expect(result).toEqual([file1, file2])
  })
})

type OpenFileHandler = (event: { preventDefault: () => void }, filePath: string) => void
type SecondInstanceHandler = (event: unknown, argv: string[]) => void

function createFakeApp(): OsFileOpenApp & {
  fireOpenFile: (filePath: string) => boolean
  fireSecondInstance: (argv: string[]) => void
  on: ReturnType<typeof vi.fn>
} {
  const openFileHandlers: OpenFileHandler[] = []
  const secondInstanceHandlers: SecondInstanceHandler[] = []
  const on = vi.fn((eventName: string, handler: OpenFileHandler | SecondInstanceHandler) => {
    if (eventName === 'open-file') {
      openFileHandlers.push(handler as OpenFileHandler)
    } else if (eventName === 'second-instance') {
      secondInstanceHandlers.push(handler as SecondInstanceHandler)
    }
  })
  return {
    on: on as OsFileOpenApp['on'] & ReturnType<typeof vi.fn>,
    fireOpenFile(filePath) {
      let defaultPrevented = false
      for (const handler of openFileHandlers) {
        handler({ preventDefault: () => (defaultPrevented = true) }, filePath)
      }
      return defaultPrevented
    },
    fireSecondInstance(argv) {
      for (const handler of secondInstanceHandlers) {
        handler({}, argv)
      }
    }
  }
}

describe('registerOsFileOpenRequests', () => {
  it('routes macOS open-file events into the queue and prevents the default', () => {
    const queue = createOsFileOpenRequestQueue()
    const app = createFakeApp()
    registerOsFileOpenRequests({ app, queue, platform: 'darwin', argv: [] })

    expect(app.fireOpenFile('/Users/x/a.md')).toBe(true)
    expect(queue.drain()).toEqual(['/Users/x/a.md'])
  })

  it('ignores argv on macOS so a double-registered path is not queued twice', () => {
    const queue = createOsFileOpenRequestQueue()
    const app = createFakeApp()
    registerOsFileOpenRequests({
      app,
      queue,
      platform: 'darwin',
      argv: ['/Applications/Orca', '/Users/x/a.md']
    })
    expect(queue.drain()).toEqual([])
  })

  it('subscribes only to open-file on darwin, never second-instance', () => {
    const queue = createOsFileOpenRequestQueue()
    const app = createFakeApp()
    registerOsFileOpenRequests({ app, queue, platform: 'darwin', argv: [] })

    expect(app.on).toHaveBeenCalledTimes(1)
    expect(app.on).toHaveBeenCalledWith('open-file', expect.any(Function))
  })

  it('reads argv on win32 and subscribes to second-instance instead of open-file', () => {
    const queue = createOsFileOpenRequestQueue()
    const app = createFakeApp()
    registerOsFileOpenRequests({
      app,
      queue,
      platform: 'win32',
      argv: ['C:\\Orca.exe', 'C:\\Users\\x\\a.md']
    })

    expect(app.on).toHaveBeenCalledTimes(1)
    expect(app.on).toHaveBeenCalledWith('second-instance', expect.any(Function))
    expect(queue.drain()).toEqual(['C:\\Users\\x\\a.md'])
  })

  it('reads argv on linux', () => {
    const queue = createOsFileOpenRequestQueue()
    const app = createFakeApp()
    registerOsFileOpenRequests({
      app,
      queue,
      platform: 'linux',
      argv: ['/opt/orca/orca', '/home/x/a.md']
    })
    expect(queue.drain()).toEqual(['/home/x/a.md'])
  })

  it('enqueues markdown paths from a later win32 second-instance launch, filtering flags and non-markdown', () => {
    const queue = createOsFileOpenRequestQueue()
    const app = createFakeApp()
    registerOsFileOpenRequests({ app, queue, platform: 'win32', argv: ['C:\\Orca.exe'] })
    queue.drain()

    app.fireSecondInstance(['C:\\Orca.exe', '--flag', 'C:\\Users\\x\\b.md', 'C:\\Users\\x\\b.txt'])

    expect(queue.drain()).toEqual(['C:\\Users\\x\\b.md'])
  })

  it('enqueues markdown paths from a later linux second-instance launch', () => {
    const queue = createOsFileOpenRequestQueue()
    const app = createFakeApp()
    registerOsFileOpenRequests({ app, queue, platform: 'linux', argv: ['/opt/orca/orca'] })
    queue.drain()

    app.fireSecondInstance(['/opt/orca/orca', '/home/x/b.md'])

    expect(queue.drain()).toEqual(['/home/x/b.md'])
  })
})
