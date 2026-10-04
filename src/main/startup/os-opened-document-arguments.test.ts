import { describe, expect, it } from 'vitest'
import { isMarkdownDocumentName } from '../ipc/markdown-documents'
import { documentPathsFromArguments } from './os-opened-documents'

describe('documentPathsFromArguments', () => {
  it('accepts CSV/TSV alongside Markdown without widening Markdown discovery', () => {
    expect(
      documentPathsFromArguments(['/notes/a.md', '/notes/b.CSV', '/notes/c.TsV'], 'darwin')
    ).toEqual(['/notes/a.md', '/notes/b.CSV', '/notes/c.TsV'])
    expect(isMarkdownDocumentName('b.csv')).toBe(false)
    expect(isMarkdownDocumentName('c.tsv')).toBe(false)
  })

  it('accepts and dedupes Windows tabular paths and file URLs', () => {
    expect(
      documentPathsFromArguments(
        [
          'C:\\notes\\a.csv',
          'file:///C:/notes/A.csv',
          '\\\\server\\share\\b.tsv',
          'file://server/share/b.tsv'
        ],
        'win32'
      )
    ).toEqual(['C:\\notes\\a.csv', '\\\\server\\share\\b.tsv'])
  })

  it('decodes tabular file URLs and excludes invalid or unsupported inputs', () => {
    expect(
      documentPathsFromArguments(
        [
          'file:///notes/query%20result.csv',
          '/notes/query result.csv',
          'file:///notes/export.tsv',
          'relative.csv',
          '../export.tsv',
          'https://example.com/export.csv',
          'file:///%zz.tsv',
          'file://server/share/a.csv',
          '--output=/notes/a.csv',
          '/notes/private.txt',
          '/notes/program.js'
        ],
        'linux'
      )
    ).toEqual(['/notes/query result.csv', '/notes/export.tsv'])
  })

  it('keeps absolute markdown paths and drops other extensions', () => {
    expect(
      documentPathsFromArguments(
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
      documentPathsFromArguments(
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
      documentPathsFromArguments([...nonDocumentEntries, '/Users/dev/notes/a.md'], 'darwin')
    ).toEqual(['/Users/dev/notes/a.md'])
  })

  it('drops relative paths because a second instance has no meaningful cwd', () => {
    expect(
      documentPathsFromArguments(['readme.md', './docs/a.md', '../up.md', ''], 'darwin')
    ).toEqual([])
  })

  it('accepts win32 drive-letter and UNC paths', () => {
    expect(
      documentPathsFromArguments(
        ['C:\\Users\\dev\\todo.md', '\\\\server\\share\\a.md', 'C:\\Users\\dev\\todo.txt'],
        'win32'
      )
    ).toEqual(['C:\\Users\\dev\\todo.md', '\\\\server\\share\\a.md'])
  })

  it('dedupes case-insensitively on win32 and keeps the first spelling', () => {
    expect(documentPathsFromArguments(['C:\\notes\\A.md', 'c:\\notes\\a.md'], 'win32')).toEqual([
      'C:\\notes\\A.md'
    ])
  })

  it('normalizes parent segments before deduping', () => {
    expect(
      documentPathsFromArguments(['C:\\notes\\sub\\..\\a.md', 'C:\\notes\\a.md'], 'win32')
    ).toEqual(['C:\\notes\\a.md'])
    expect(documentPathsFromArguments(['/docs/../notes/a.md', '/notes/a.md'], 'darwin')).toEqual([
      '/notes/a.md'
    ])
  })

  it('does not dedupe case-insensitively on posix, where casing is a different file', () => {
    expect(documentPathsFromArguments(['/a/A.md', '/a/a.md'], 'linux')).toEqual([
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
      documentPathsFromArguments(
        ['file:///home/me/notes/a.md', 'file:///home/me/notes/b.txt'],
        'linux'
      )
    ).toEqual(['/home/me/notes/a.md'])
  })

  it('percent-decodes a file:// URI so a path with spaces still opens', () => {
    expect(documentPathsFromArguments(['file:///home/me/design%20notes.md'], 'linux')).toEqual([
      '/home/me/design notes.md'
    ])
  })

  it('decodes win32 file:// URIs, including UNC authority form', () => {
    expect(
      documentPathsFromArguments(
        ['file:///C:/Users/me/todo.md', 'file://server/share/a.md'],
        'win32'
      )
    ).toEqual(['C:\\Users\\me\\todo.md', '\\\\server\\share\\a.md'])
  })

  it('dedupes a path delivered as both a URI and a bare path', () => {
    expect(documentPathsFromArguments(['file:///home/me/a.md', '/home/me/a.md'], 'linux')).toEqual([
      '/home/me/a.md'
    ])
  })

  it('drops a malformed or non-file URL instead of throwing', () => {
    expect(() =>
      documentPathsFromArguments(['file://', 'file:///%zz.md', 'https://example.com/a.md'], 'linux')
    ).not.toThrow()
    expect(
      documentPathsFromArguments(['file://', 'file:///%zz.md', 'https://example.com/a.md'], 'linux')
    ).toEqual([])
  })

  it('honours the platform argument rather than the host OS', () => {
    const argv = ['C:\\notes\\a.md', '/notes/b.md']
    // Same argv, two platforms: a win32 path is not absolute to posix, and posix input is
    // renormalized to backslashes on win32. Neither result may depend on where the suite runs.
    expect(documentPathsFromArguments(argv, 'darwin')).toEqual(['/notes/b.md'])
    expect(documentPathsFromArguments(argv, 'win32')).toEqual(['C:\\notes\\a.md', '\\notes\\b.md'])
  })
})
