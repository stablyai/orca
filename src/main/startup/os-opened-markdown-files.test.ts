import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isMarkdownDocumentName } from '../ipc/markdown-documents'
import {
  MAX_PENDING_OS_OPENED_MARKDOWN_FILES,
  OsOpenedMarkdownFileState,
  markdownPathsFromArguments,
  resolveOpenedMarkdownDocuments
} from './os-opened-markdown-files'

vi.mock('../ipc/filesystem-auth', () => ({
  authorizeExternalPath: vi.fn()
}))
vi.mock('../ipc/floating-workspace-directory', () => ({
  ensureDefaultFloatingWorkspacePath: vi.fn()
}))

const { authorizeExternalPath } = await import('../ipc/filesystem-auth')
const { ensureDefaultFloatingWorkspacePath } = await import('../ipc/floating-workspace-directory')

describe('markdownPathsFromArguments', () => {
  it('keeps absolute markdown paths and drops other extensions', () => {
    expect(
      markdownPathsFromArguments(
        [
          '/Users/dev/notes/a.md',
          '/Users/dev/notes/b.markdown',
          '/Users/dev/notes/c.mdx',
          '/Users/dev/notes/d.txt',
          '/Users/dev/src/e.tsx',
          '/Users/dev/notes/README'
        ],
        'darwin'
      )
    ).toEqual(['/Users/dev/notes/a.md', '/Users/dev/notes/b.markdown', '/Users/dev/notes/c.mdx'])
  })

  it('drops switches, including Chromium-style ones that would otherwise look like values', () => {
    expect(
      markdownPathsFromArguments(
        ['--serve', '-v', '--allow-file-access-from-files', '/Users/dev/notes/a.md'],
        'darwin'
      )
    ).toEqual(['/Users/dev/notes/a.md'])
  })

  it('drops the executable and dev entries because none of them end in a markdown extension', () => {
    const nonDocumentEntries = [
      '/Applications/Orca.app/Contents/MacOS/Orca',
      '/Users/dev/orca/out/main/index.js',
      '/Applications/Orca.app/Contents/Resources/app.asar'
    ]
    // The module documents that the extension check alone excludes these; hold it to that.
    for (const entry of nonDocumentEntries) {
      expect(isMarkdownDocumentName(entry), entry).toBe(false)
    }
    expect(
      markdownPathsFromArguments([...nonDocumentEntries, '/Users/dev/notes/a.md'], 'darwin')
    ).toEqual(['/Users/dev/notes/a.md'])
  })

  it('drops relative paths because a second instance has no meaningful cwd', () => {
    expect(
      markdownPathsFromArguments(['readme.md', './docs/a.md', '../up.md', ''], 'darwin')
    ).toEqual([])
  })

  it('accepts win32 drive-letter and UNC paths', () => {
    expect(
      markdownPathsFromArguments(
        ['C:\\Users\\dev\\todo.md', '\\\\server\\share\\a.md', 'C:\\Users\\dev\\todo.txt'],
        'win32'
      )
    ).toEqual(['C:\\Users\\dev\\todo.md', '\\\\server\\share\\a.md'])
  })

  it('dedupes case-insensitively on win32 and keeps the first spelling', () => {
    expect(markdownPathsFromArguments(['C:\\notes\\A.md', 'c:\\notes\\a.md'], 'win32')).toEqual([
      'C:\\notes\\A.md'
    ])
  })

  it('normalizes parent segments before deduping', () => {
    expect(
      markdownPathsFromArguments(['C:\\notes\\sub\\..\\a.md', 'C:\\notes\\a.md'], 'win32')
    ).toEqual(['C:\\notes\\a.md'])
    expect(markdownPathsFromArguments(['/docs/../notes/a.md', '/notes/a.md'], 'darwin')).toEqual([
      '/notes/a.md'
    ])
  })

  it('does not dedupe case-insensitively on posix, where casing is a different file', () => {
    expect(markdownPathsFromArguments(['/a/A.md', '/a/a.md'], 'linux')).toEqual([
      '/a/A.md',
      '/a/a.md'
    ])
  })

  it('accepts a file:// URI, which the desktop entry %U field code permits', () => {
    // Why defensive rather than load-bearing: GLib decodes a local file:// URI to a plain
    // path before spawning (measured on Ubuntu 24.04), so Linux hits the plain-path branch
    // today. The %U spec still allows a URI, and a launcher that passes one literally would
    // otherwise be dropped without a trace.
    expect(
      markdownPathsFromArguments(
        ['file:///home/me/notes/a.md', 'file:///home/me/notes/b.txt'],
        'linux'
      )
    ).toEqual(['/home/me/notes/a.md'])
  })

  it('percent-decodes a file:// URI so a path with spaces still opens', () => {
    expect(markdownPathsFromArguments(['file:///home/me/design%20notes.md'], 'linux')).toEqual([
      '/home/me/design notes.md'
    ])
  })

  it('decodes win32 file:// URIs, including UNC authority form', () => {
    expect(
      markdownPathsFromArguments(
        ['file:///C:/Users/me/todo.md', 'file://server/share/a.md'],
        'win32'
      )
    ).toEqual(['C:\\Users\\me\\todo.md', '\\\\server\\share\\a.md'])
  })

  it('dedupes a path delivered as both a URI and a bare path', () => {
    expect(markdownPathsFromArguments(['file:///home/me/a.md', '/home/me/a.md'], 'linux')).toEqual([
      '/home/me/a.md'
    ])
  })

  it('drops a malformed or non-file URL instead of throwing', () => {
    expect(() =>
      markdownPathsFromArguments(['file://', 'file:///%zz.md', 'https://example.com/a.md'], 'linux')
    ).not.toThrow()
    expect(
      markdownPathsFromArguments(['file://', 'file:///%zz.md', 'https://example.com/a.md'], 'linux')
    ).toEqual([])
  })

  it('honours the platform argument rather than the host OS', () => {
    const argv = ['C:\\notes\\a.md', '/notes/b.md']
    // Same argv, two platforms: a win32 path is not absolute to posix, and posix input is
    // renormalized to backslashes on win32. Neither result may depend on where the suite runs.
    expect(markdownPathsFromArguments(argv, 'darwin')).toEqual(['/notes/b.md'])
    expect(markdownPathsFromArguments(argv, 'win32')).toEqual(['C:\\notes\\a.md', '\\notes\\b.md'])
  })
})

// Why resolve(): the state uses the host platform by default, so fixture paths must already be
// spelled the way the host's path module normalizes them (`\n\a.md` and a drive on Windows).
const hostPath = (name: string): string => resolve(sep, 'notes', name)

describe('OsOpenedMarkdownFileState', () => {
  it('reports no capture and does not publish when argv carries no markdown', () => {
    const state = new OsOpenedMarkdownFileState()
    const publish = vi.fn()

    expect(state.capture(['/Applications/Orca.app/Contents/MacOS/Orca', '--serve'], publish)).toBe(
      false
    )
    expect(publish).not.toHaveBeenCalled()
    expect(state.consume()).toEqual([])
  })

  it('buffers and publishes when argv carries markdown', () => {
    const state = new OsOpenedMarkdownFileState()
    const publish = vi.fn()
    const filePath = hostPath('a.md')

    expect(state.capture(['/Applications/Orca.app/Contents/MacOS/Orca', filePath], publish)).toBe(
      true
    )
    expect(publish).toHaveBeenCalledTimes(1)
    expect(state.consume()).toEqual([filePath])
  })

  it('captures a single macOS open-file path', () => {
    const state = new OsOpenedMarkdownFileState()
    const publish = vi.fn()
    const filePath = hostPath('a.md')

    expect(state.captureFilePaths([filePath], publish)).toBe(true)
    expect(state.captureFilePaths([hostPath('a.png')], publish)).toBe(false)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(state.consume()).toEqual([filePath])
  })

  it('does not duplicate a path captured twice', () => {
    const state = new OsOpenedMarkdownFileState()
    const filePath = hostPath('a.md')

    state.captureFilePaths([filePath])
    state.captureFilePaths([filePath])
    state.capture(['orca', filePath])

    expect(state.consume()).toEqual([filePath])
  })

  it('drains the buffer on consume', () => {
    const state = new OsOpenedMarkdownFileState()
    const paths = [hostPath('a.md'), hostPath('b.md')]
    state.captureFilePaths(paths)

    expect(state.consume()).toEqual(paths)
    expect(state.consume()).toEqual([])
  })

  it('restores an undelivered batch at the front of the buffer', () => {
    const state = new OsOpenedMarkdownFileState()
    state.captureFilePaths([hostPath('later.md')])

    state.restore([hostPath('undelivered.md')])

    expect(state.consume()).toEqual([hostPath('undelivered.md'), hostPath('later.md')])
  })

  it('caps the buffer when captures overflow it', () => {
    const state = new OsOpenedMarkdownFileState()
    const overflow = MAX_PENDING_OS_OPENED_MARKDOWN_FILES + 5
    const paths = Array.from({ length: overflow }, (_, index) => hostPath(`file-${index}.md`))

    expect(state.captureFilePaths(paths)).toBe(true)

    expect(state.consume()).toEqual(paths.slice(0, MAX_PENDING_OS_OPENED_MARKDOWN_FILES))
  })

  it('caps the buffer when a restore overflows it', () => {
    const state = new OsOpenedMarkdownFileState()
    state.captureFilePaths([hostPath('pending.md')])
    const restored = Array.from({ length: MAX_PENDING_OS_OPENED_MARKDOWN_FILES }, (_, index) =>
      hostPath(`restored-${index}.md`)
    )

    state.restore(restored)

    const pending = state.consume()
    expect(pending).toHaveLength(MAX_PENDING_OS_OPENED_MARKDOWN_FILES)
    expect(pending).toEqual(restored)
  })
})

describe('resolveOpenedMarkdownDocuments', () => {
  let floatingRoot: string
  let fileRoot: string

  beforeEach(async () => {
    vi.mocked(authorizeExternalPath).mockClear()
    vi.mocked(ensureDefaultFloatingWorkspacePath).mockClear()
    floatingRoot = await mkdtemp(join(tmpdir(), 'orca-os-open-root-'))
    fileRoot = await mkdtemp(join(tmpdir(), 'orca-os-open-files-'))
    vi.mocked(ensureDefaultFloatingWorkspacePath).mockResolvedValue(floatingRoot)
  })

  afterEach(async () => {
    await rm(floatingRoot, { recursive: true, force: true })
    await rm(fileRoot, { recursive: true, force: true })
  })

  it('resolves a real file outside the floating root to a basename-relative document', async () => {
    const filePath = join(fileRoot, 'design notes.md')
    await writeFile(filePath, '# hi\n', 'utf8')

    const documents = await resolveOpenedMarkdownDocuments([filePath])

    expect(documents).toEqual([
      {
        filePath,
        relativePath: 'design notes.md',
        basename: 'design notes.md',
        name: 'design notes'
      }
    ])
    expect(authorizeExternalPath).toHaveBeenCalledWith(filePath)
  })

  it('drops a directory that merely looks like a markdown file', async () => {
    const bundlePath = join(fileRoot, 'bundle.md')
    await mkdir(bundlePath)
    const filePath = join(fileRoot, 'real.md')
    await writeFile(filePath, '# hi\n', 'utf8')

    const documents = await resolveOpenedMarkdownDocuments([bundlePath, filePath])

    expect(documents.map((document) => document.filePath)).toEqual([filePath])
    // Security contract: a path we never validated must never be authorized for renderer reads.
    expect(authorizeExternalPath).toHaveBeenCalledTimes(1)
    expect(authorizeExternalPath).toHaveBeenCalledWith(filePath)
  })

  it('drops a path that no longer exists without authorizing it', async () => {
    const missingPath = join(fileRoot, 'gone.md')

    expect(await resolveOpenedMarkdownDocuments([missingPath])).toEqual([])
    expect(authorizeExternalPath).not.toHaveBeenCalled()
  })

  it('returns nothing for an empty input without touching the filesystem', async () => {
    expect(await resolveOpenedMarkdownDocuments([])).toEqual([])
    expect(ensureDefaultFloatingWorkspacePath).not.toHaveBeenCalled()
    expect(authorizeExternalPath).not.toHaveBeenCalled()
  })
})
