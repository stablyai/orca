import { createReadStream } from 'node:fs'
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareLegacyTranscriptImport } from './journal-legacy-import'

vi.mock(import('node:fs'), async (importOriginal) => {
  const original = await importOriginal()
  return { ...original, createReadStream: vi.fn(original.createReadStream) }
})

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal()
  return { ...original, stat: vi.fn() }
})

const SOURCE_LIMIT_BYTES = 16 * 1024 * 1024
const roots: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('legacy import source byte bound', () => {
  it('refuses a source that grows past the limit after stat and closes the stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-legacy-import-bound-'))
    roots.push(root)
    const filePath = join(root, 'growing.jsonl')
    await writeFile(
      filePath,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'first-message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Keep the prior journal' }] }
      })}\n`
    )
    const actualFs = await vi.importActual<typeof FsPromises>('node:fs/promises')
    const beforeGrowth = await actualFs.stat(filePath)
    vi.mocked(stat).mockImplementationOnce(async () => {
      await appendFile(filePath, Buffer.alloc(SOURCE_LIMIT_BYTES, 0x20))
      return beforeGrowth
    })

    const result = await prepareLegacyTranscriptImport({
      agent: 'claude',
      sessionId: 'source-bound',
      options: { filePath }
    })

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(`${SOURCE_LIMIT_BYTES} byte limit`)
    })
    expect(createReadStream).toHaveBeenCalledOnce()
    expect(vi.mocked(createReadStream).mock.results[0]?.value.destroyed).toBe(true)
  })
})
