import type { ReadStream } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readCodexRolloutBytes } from './codex-rollout-history-stream'

const input = vi.hoisted(() => ({
  file: null as ReadStream | null,
  ended: null as Promise<void> | null
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const file = actual.createReadStream(...args)
      input.file = file
      input.ended = new Promise<void>((resolve) => file.once('end', resolve))
      return file
    }
  }
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-rollout-abort-'))
  input.file = null
  input.ended = null
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fixture(contents: Buffer, compressed = true): Promise<string> {
  const path = join(root, compressed ? 'rollout.jsonl.zst' : 'rollout.jsonl')
  await writeFile(path, compressed ? zstdCompressSync(contents) : contents)
  return path
}

async function read(path: string, end?: number): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of readCodexRolloutBytes(path, end)) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe('Codex rollout decoding cancellation', () => {
  it('refuses more decoded data after cancellation at compressed-input EOF', async () => {
    const path = await fixture(Buffer.from('{}\n'.repeat(2_000_000)))
    const controller = new AbortController()
    const iterator = readCodexRolloutBytes(path, undefined, controller.signal)
    try {
      expect((await iterator.next()).done).toBe(false)
      await input.ended
      expect(input.file?.readableEnded).toBe(true)
      controller.abort()
      await expect(iterator.next().then(() => 'yielded after cancellation')).rejects.toMatchObject({
        name: 'AbortError'
      })
      expect(input.file?.closed).toBe(true)
    } finally {
      await iterator.return(undefined)
    }
  })

  it.each([false, true])('keeps decoded byte bookmarks for compressed=%s', async (compressed) => {
    const path = await fixture(Buffer.from('first\nsecond\n'), compressed)
    await expect(read(path, 6)).resolves.toBe('first\n')
  })

  it('still reads a complete compressed rollout without cancellation', async () => {
    const path = await fixture(Buffer.from('first\nsecond\n'))
    await expect(read(path)).resolves.toBe('first\nsecond\n')
  })

  it('preserves decompression failures', async () => {
    const path = join(root, 'invalid.jsonl.zst')
    await writeFile(path, 'not a zstd stream')
    await expect(read(path)).rejects.toThrow()
  })

  it('rejects an already cancelled read', async () => {
    const path = await fixture(Buffer.from('first\n'))
    const controller = new AbortController()
    controller.abort()
    const iterator = readCodexRolloutBytes(path, undefined, controller.signal)
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' })
  })
})
