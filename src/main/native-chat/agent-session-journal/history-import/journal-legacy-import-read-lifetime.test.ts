import type * as NodeFs from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readLegacyImportTranscript } from './journal-legacy-transcript-stream'
import { readCodexRolloutBytes } from '../../codex-rollout-history-stream'

const { opened } = vi.hoisted(() => {
  const opened: NodeFs.ReadStream[] = []
  return { opened }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      opened.push(stream)
      return stream
    }
  }
})

let root: string
beforeEach(async () => {
  opened.length = 0
  root = await mkdtemp(join(tmpdir(), 'orca-import-lifetime-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

it('closes the ordinary source before an awaited visitor failure settles', async () => {
  const filePath = join(root, 'session.jsonl')
  await writeFile(filePath, '{"type":"assistant"}\n'.repeat(10000))
  const failure = new Error('visitor failed')
  await expect(
    readLegacyImportTranscript({ filePath, codex: false }, async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      throw failure
    })
  ).rejects.toBe(failure)
  expect(opened[0]).toBeDefined()
  expect(opened[0]?.closed).toBe(true)
})

it('closes a compressed physical source when cancellation interrupts its consumer', async () => {
  const filePath = join(root, 'session.jsonl.zst')
  const source = Buffer.from('{"type":"assistant"}\n'.repeat(10000))
  await writeFile(filePath, zstdCompressSync(source))
  const controller = new AbortController()
  const failure = new Error('cancel import')
  const consume = async () => {
    for await (const _chunk of readCodexRolloutBytes(filePath, undefined, controller.signal)) {
      controller.abort(failure)
    }
  }
  await expect(consume()).rejects.toBe(failure)
  expect(opened[0]).toBeDefined()
  expect(opened[0]?.closed).toBe(true)
})
