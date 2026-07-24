import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  MARKDOWN_DOCUMENT_LISTING_MAX_DOCUMENTS,
  MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES,
  MarkdownDocumentListingCapacityError
} from '../shared/markdown-document-listing-limits'
import {
  listMarkdownPathsWithRg,
  listRelayMarkdownDocumentPaths
} from './markdown-document-listing'

function successfulChild(output: Buffer): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  }) as unknown as ChildProcess
  queueMicrotask(() => {
    child.stdout!.emit('data', output)
    child.emit('close', 0, null)
  })
  return child
}

describe('relay Markdown document producer', () => {
  it('returns only Markdown paths from a real under-limit workspace', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'orca-markdown-listing-'))
    try {
      await mkdir(join(rootPath, 'docs'))
      await writeFile(join(rootPath, 'README.md'), 'readme')
      await writeFile(join(rootPath, 'docs', 'Guide.MDX'), 'guide')
      await writeFile(join(rootPath, 'docs', 'app.ts'), 'code')

      const result = await listRelayMarkdownDocumentPaths(rootPath)
      expect(result.sort()).toEqual(['README.md', 'docs/Guide.MDX'])
    } finally {
      await rm(rootPath, { recursive: true, force: true })
    }
  })

  it('filters a large non-Markdown repository before applying document retention limits', async () => {
    const nonMarkdown = Array.from({ length: 100_001 }, (_value, index) => `src/${index}.ts\0`)
    const output = Buffer.from(`${nonMarkdown.join('')}README.md\0docs/GUIDE.MDX\0`)
    const spawnProcess = vi.fn((_args: string[]) => successfulChild(output))

    await expect(listMarkdownPathsWithRg('/repo', undefined, spawnProcess)).resolves.toEqual([
      'README.md',
      'docs/GUIDE.MDX'
    ])
    expect(spawnProcess).toHaveBeenCalledTimes(2)
    expect(spawnProcess.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['--iglob', '*.md', '--null'])
    )
  })

  it('rejects rather than truncating the first document beyond the count limit', async () => {
    const output = Buffer.from(
      Array.from(
        { length: MARKDOWN_DOCUMENT_LISTING_MAX_DOCUMENTS + 1 },
        (_value, index) => `${index}.md\0`
      ).join('')
    )
    const children: ChildProcess[] = []
    const spawnProcess = vi.fn(() => {
      const child = successfulChild(output)
      children.push(child)
      return child
    })

    await expect(listMarkdownPathsWithRg('/repo', undefined, spawnProcess)).rejects.toBeInstanceOf(
      MarkdownDocumentListingCapacityError
    )
    expect(children[0]?.kill).toHaveBeenCalled()
    expect(spawnProcess).toHaveBeenCalledTimes(1)
  })

  it('bounds an unterminated subprocess path before decoding or retaining it', async () => {
    const child = successfulChild(Buffer.alloc(MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES + 1, 0x61))

    await expect(listMarkdownPathsWithRg('/repo', undefined, () => child)).rejects.toBeInstanceOf(
      MarkdownDocumentListingCapacityError
    )
    expect(child.kill).toHaveBeenCalled()
  })
})
