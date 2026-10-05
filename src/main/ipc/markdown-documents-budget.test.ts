import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('../ripgrep/bundled-ripgrep-spawn', () => ({ spawnBundledRipgrep: spawnMock }))

import { listMarkdownDocuments, markdownDocumentsFromRelativePaths } from './markdown-documents'

class ListingProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid: number | undefined = 123
  kill = vi.fn(() => true)
}

let child: ListingProcess
const capacityFailure = { code: 'markdown_document_listing_capacity' }
const countPaths = Array.from({ length: 20_000 }, (_, index) => `${index}.md`)
// These 32 distinct paths consume exactly the literal 8-MiB retained-metadata ceiling.
const metadataPaths = Array.from(
  { length: 32 },
  (_, index) => `${String(index).padStart(2, '0')}${'x'.repeat(32_731)}.md`
)

beforeEach(() => {
  child = new ListingProcess()
  spawnMock.mockReset().mockReturnValue(child)
})

afterEach(() => {
  vi.useRealTimers()
})

function writeRecords(paths: string[]): void {
  const bytes = Buffer.from(paths.map((path) => `./${path}\0`).join(''))
  for (let start = 0; start < bytes.length; start += 65_536) {
    child.stdout.write(bytes.subarray(start, start + 65_536))
  }
}

describe('Markdown document producer budgets', () => {
  it.each([
    { kind: 'count', paths: countPaths, length: 20_000 },
    { kind: 'metadata', paths: metadataPaths, length: 32 }
  ])('accepts the exact $kind ceiling', async ({ paths, length }) => {
    const listing = listMarkdownDocuments('/r')
    writeRecords(paths)
    child.emit('close', 0, null)
    expect(await listing).toHaveLength(length)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'count', paths: countPaths },
    { kind: 'metadata', paths: metadataPaths }
  ])('rejects $kind overflow before process exit and releases the listing', async ({ paths }) => {
    vi.useFakeTimers()
    const listing = listMarkdownDocuments('/r')
    const refused = expect(listing).rejects.toMatchObject(capacityFailure)
    writeRecords([...paths, 'overflow.md'])
    const killBeforeClose = child.kill.mock.calls.length
    child.emit('close', 0, null)
    await refused

    expect(killBeforeClose).toBe(1)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => child.emit('error', new Error('late spawn error'))).not.toThrow()
    expect(() => child.stdout.emit('error', new Error('late pipe error'))).not.toThrow()
  })

  it('accepts a full document path at the literal 64-KiB ceiling', async () => {
    const listing = listMarkdownDocuments('/r')
    writeRecords([`${'x'.repeat(65_530)}.md`])
    child.emit('close', 0, null)
    const documents = await listing
    expect(documents).toHaveLength(1)
    expect(Buffer.byteLength(documents[0].filePath)).toBe(65_536)
  })

  it.each(['complete', 'residual'] as const)(
    'rejects a split Unicode %s path beyond 64 KiB',
    async (kind) => {
      const listing = listMarkdownDocuments('/r')
      const refused = expect(listing).rejects.toMatchObject(capacityFailure)
      const bytes = Buffer.from(`./${'é'.repeat(32_768)}.md${kind === 'complete' ? '\0' : ''}`)
      child.stdout.write(bytes.subarray(0, 65_535))
      child.stdout.write(bytes.subarray(65_535))
      const killBeforeClose = child.kill.mock.calls.length
      child.emit('close', 0, null)
      await refused
      expect(killBeforeClose).toBe(1)
    }
  )

  it('refuses an oversized root before spawning a process', async () => {
    const listing = listMarkdownDocuments(`/${'r'.repeat(65_536)}`)
    child.emit('close', 1, null)
    await expect(listing).rejects.toMatchObject(capacityFailure)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not signal a missing process when budget admission fails', async () => {
    const listing = listMarkdownDocuments('/r')
    const refused = expect(listing).rejects.toMatchObject(capacityFailure)
    child.pid = undefined
    writeRecords([...metadataPaths, 'overflow.md'])
    child.emit('close', 0, null)
    await refused
    expect(child.kill).not.toHaveBeenCalled()
  })
})

describe('Markdown converted-object budgets', () => {
  it.each([
    { kind: 'count', paths: countPaths, length: 20_000 },
    { kind: 'metadata', paths: metadataPaths, length: 32 }
  ])('accepts the exact $kind ceiling', ({ paths, length }) => {
    expect(markdownDocumentsFromRelativePaths('/r', paths)).toHaveLength(length)
  })

  it.each([
    { kind: 'count', paths: countPaths },
    { kind: 'metadata', paths: metadataPaths }
  ])('refuses the entire $kind overflow result', ({ paths }) => {
    expect(() => markdownDocumentsFromRelativePaths('/r', [...paths, 'overflow.md'])).toThrow(
      expect.objectContaining(capacityFailure)
    )
  })

  it('refuses a converted full path beyond 64 KiB', () => {
    expect(() => markdownDocumentsFromRelativePaths('/r', [`${'é'.repeat(32_768)}.md`])).toThrow(
      expect.objectContaining(capacityFailure)
    )
  })

  it('counts only accepted Markdown paths and preserves POSIX backslashes', () => {
    const paths = [
      ...Array.from({ length: 20_001 }, (_, index) => `${index}.ts`),
      '../outside.md',
      'nested/.md',
      'nested/guide.MDX',
      '..\\notes.md'
    ]
    expect(
      markdownDocumentsFromRelativePaths('/r', paths).map((document) => document.relativePath)
    ).toEqual(['..\\notes.md', 'nested/guide.MDX'])
  })

  it('preserves Windows remote separators and escape refusal', () => {
    expect(
      markdownDocumentsFromRelativePaths('C:\\repo\\', [
        'nested\\guide.MDX',
        '..\\outside.md',
        'README.md'
      ]).map((document) => document.relativePath)
    ).toEqual(['nested/guide.MDX', 'README.md'])
  })
})
