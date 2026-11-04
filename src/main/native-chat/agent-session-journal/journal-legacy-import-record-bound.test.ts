import { createReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareLegacyTranscriptImport } from './journal-legacy-import'

vi.mock(import('node:fs'), async (importOriginal) => {
  const original = await importOriginal()
  return { ...original, createReadStream: vi.fn(original.createReadStream) }
})

const RECORD_LIMIT_BYTES = 16 * 1024 * 1024
const roots: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.each(['claude', 'codex'] as const)('record byte bound: %s', (agent) => {
  it('refuses a single line past the limit and closes the stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-legacy-import-bound-'))
    roots.push(root)
    const filePath = join(root, 'oversized-line.jsonl')
    await writeFile(filePath, ' '.repeat(RECORD_LIMIT_BYTES + 1))

    const result = await prepareLegacyTranscriptImport({
      agent,
      sessionId: 'record-bound',
      options: { filePath }
    })

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(`${RECORD_LIMIT_BYTES} byte limit`)
    })
    expect(createReadStream).toHaveBeenCalledOnce()
    expect(vi.mocked(createReadStream).mock.results[0]?.value.destroyed).toBe(true)
  })
})
