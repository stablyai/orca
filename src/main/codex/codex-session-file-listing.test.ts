import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexSessionListingCapacityError,
  listCodexSessionJsonlFilesIncrementally,
  listCodexSessionJsonlFilesWithinLimits
} from './codex-session-file-listing'

const tempRoots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-session-listing-'))
  tempRoots.push(root)
  return root
}

async function collect(files: AsyncIterable<string>): Promise<string[]> {
  const collected: string[] = []
  for await (const file of files) {
    collected.push(file)
  }
  return collected
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Codex session file-listing limits', () => {
  it('preserves sorted JSONL discovery below every limit', async () => {
    const root = await makeRoot()
    await mkdir(join(root, '2026', '01', '02'), { recursive: true })
    const later = join(root, '2026', '01', '02', 'z.jsonl')
    const earlier = join(root, '2026', '01', '02', 'a.jsonl')
    await writeFile(later, '{}')
    await writeFile(earlier, '{}')
    await writeFile(join(root, '2026', '01', '02', 'ignored.txt'), 'x')

    expect(listCodexSessionJsonlFilesWithinLimits(root)).toEqual([earlier, later])
  })

  it('accepts exact entry and file limits, then rejects the next file', async () => {
    const root = await makeRoot()
    await writeFile(join(root, 'a.jsonl'), '{}')
    await writeFile(join(root, 'b.jsonl'), '{}')

    expect(
      listCodexSessionJsonlFilesWithinLimits(root, { maxEntries: 2, maxFiles: 2 })
    ).toHaveLength(2)
    await writeFile(join(root, 'c.jsonl'), '{}')
    expect(() =>
      listCodexSessionJsonlFilesWithinLimits(root, { maxEntries: 3, maxFiles: 2 })
    ).toThrow('Codex session listing exceeded 2 files')
  })

  it('bounds a zero-file directory tree by entries and depth', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'a', 'b'), { recursive: true })

    expect(listCodexSessionJsonlFilesWithinLimits(root, { maxEntries: 2, maxDepth: 2 })).toEqual([])
    expect(() =>
      listCodexSessionJsonlFilesWithinLimits(root, { maxEntries: 1, maxDepth: 2 })
    ).toThrow('Codex session listing exceeded 1 entries')
    expect(() =>
      listCodexSessionJsonlFilesWithinLimits(root, { maxEntries: 2, maxDepth: 1 })
    ).toThrow('Codex session listing exceeded 1 depth')
  })

  it('accepts the exact aggregate path limit and rejects one code unit less', async () => {
    const root = await makeRoot()
    const filePath = join(root, 'a.jsonl')
    await writeFile(filePath, '{}')
    const exactPathCodeUnits = root.length + filePath.length

    expect(
      listCodexSessionJsonlFilesWithinLimits(root, {
        maxPathCodeUnits: exactPathCodeUnits
      })
    ).toEqual([filePath])
    expect(() =>
      listCodexSessionJsonlFilesWithinLimits(root, {
        maxPathCodeUnits: exactPathCodeUnits - 1
      })
    ).toThrow(`Codex session listing exceeded ${exactPathCodeUnits - 1} path code units`)
  })

  it('stops an incremental scan at capacity and reports it as a failed directory', async () => {
    const root = await makeRoot()
    await writeFile(join(root, 'a.jsonl'), '{}')
    await writeFile(join(root, 'b.jsonl'), '{}')
    const onDirectoryError = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const files = await collect(
      listCodexSessionJsonlFilesIncrementally(
        root,
        { batchSize: 1, limits: { maxFiles: 1 }, yieldMs: 0 },
        onDirectoryError
      )
    )

    expect(files).toHaveLength(1)
    expect(onDirectoryError).toHaveBeenCalledWith(
      root,
      expect.any(CodexSessionListingCapacityError)
    )
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
