import { describe, expect, it, vi } from 'vitest'
import {
  createOsFileOpenRequestQueue,
  extractMarkdownPathsFromArgv,
  isMarkdownFilePath
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
