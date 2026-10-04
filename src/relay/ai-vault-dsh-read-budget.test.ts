import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'
import { readRelayTranscriptBytes } from './ai-vault-transcript-stream'
import { decompressDshFrames } from '../main/ai-vault/session-scanner-dsh-zstd'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function path() {
  const root = await mkdtemp(join(tmpdir(), 'orca-dsh-budget-'))
  roots.push(root)
  const file = join(root, 'sessions', 'project', 'session-budget', 'session.v1.jsonl.zstd')
  await mkdir(dirname(file), { recursive: true })
  return file
}
async function drain(file: string) {
  for await (const chunk of decompressDshFrames(
    readRelayTranscriptBytes(file, undefined, 'dsh-zstd')
  )) {
    expect(Buffer.isBuffer(chunk)).toBe(true)
  }
}

it('refuses an oversized physical compressed frame through the relay reader', async () => {
  const file = await path()
  const handle = await open(file, 'w')
  try {
    await handle.write(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0x38]))
    const header = Buffer.alloc(3)
    header.writeUIntLE((128 * 1024) << 3, 0, 3)
    const block = Buffer.alloc(128 * 1024, 0x61)
    for (let index = 0; index < 257; index++) {
      await handle.write(header)
      await handle.write(block)
    }
  } finally {
    await handle.close()
  }
  await expect(drain(file)).rejects.toThrow('compressed frame exceeds history read budget')
})

it('refuses a valid small compressed frame whose decoded output exceeds the budget', async () => {
  const file = await path()
  const frame = zstdCompressSync(Buffer.alloc(64 * 1024 * 1024 + 1, 0x61))
  expect(frame.length).toBeLessThan(64 * 1024)
  await writeFile(file, frame)
  await expect(drain(file)).rejects.toThrow('decoded frame exceeds history read budget')
})
