import { createReadStream } from 'node:fs'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
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

it('streams a valid source past 128 MiB, retaining recent bounded history and closing its readers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-legacy-import-long-'))
  roots.push(root)
  const filePath = join(root, 'long.jsonl')
  const file = await open(filePath, 'w')
  try {
    const output = 'x'.repeat(1024 * 1024)
    for (let index = 0; index < 130; index++) {
      await file.write(
        `${JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: String(index), output }
        })}\n`
      )
    }
    await file.write(
      `${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'recent answer' }]
        }
      })}\n`
    )
  } finally {
    await file.close()
  }
  const result = await prepareLegacyTranscriptImport({
    agent: 'codex',
    sessionId: 'long',
    options: { filePath }
  })
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(result.error)
  }
  expect(result.items.at(-1)?.body).toMatchObject({ blocks: [{ text: 'recent answer' }] })
  expect(
    result.items.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0)
  ).toBeLessThanOrEqual(RECORD_LIMIT_BYTES)
  expect(
    vi.mocked(createReadStream).mock.results.every(({ value }) => value.destroyed && value.closed)
  ).toBe(true)
})
