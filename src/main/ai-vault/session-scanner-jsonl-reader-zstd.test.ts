import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { consumeCompleteJsonlLines } from './session-scanner-jsonl-reader'

let tempDirs: string[] = []

async function writeZstdTranscript(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-jsonl-zstd-'))
  tempDirs.push(dir)
  const path = join(dir, name)
  await writeFile(path, zstdCompressSync(Buffer.from(contents, 'utf-8')))
  return path
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('consumeCompleteJsonlLines over compressed transcripts', () => {
  it('yields decompressed lines from zero', async () => {
    const path = await writeZstdTranscript('rollout-2026-a.jsonl.zst', '{"n":1}\n{"n":2}\n')
    const lines: string[] = []
    const result = await consumeCompleteJsonlLines({ path, start: 0, onLine: (l) => lines.push(l) })
    expect(lines).toEqual(['{"n":1}', '{"n":2}'])
    expect(result.consumedThrough).toBe(16)
  })

  it('refuses a nonzero resume offset into the immutable archive', async () => {
    const path = await writeZstdTranscript('rollout-2026-b.jsonl.zst', '{"n":1}\n')
    await expect(
      consumeCompleteJsonlLines({ path, start: 8, onLine: () => undefined })
    ).rejects.toThrow(/cannot resume/)
  })
})
