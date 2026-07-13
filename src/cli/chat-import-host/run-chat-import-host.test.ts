import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  encodeNativeMessage,
  MAX_FRAME_BYTES,
  NativeMessageDecoder
} from './native-messaging-frame'
import { runChatImportHost } from './run-chat-import-host'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
  dirs = []
})

describe('runChatImportHost', () => {
  it('reads a framed INGEST and writes a framed response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-host-run-'))
    dirs.push(dir)
    const dbPath = join(dir, 'chats.db')
    const input = new PassThrough()
    const output = new PassThrough()
    const responses: unknown[] = []
    const decoder = new NativeMessageDecoder()
    output.on('data', (chunk: Buffer) => {
      for (const raw of decoder.feed(chunk)) {
        responses.push(JSON.parse(raw))
      }
    })

    const done = runChatImportHost({ input, output, dbPath, now: () => 'now' })
    input.write(
      encodeNativeMessage({
        type: 'INGEST',
        conv: {
          source: 'CHATGPT',
          externalId: 'c1',
          title: 'T',
          createdAt: null,
          updatedAt: null,
          messages: [{ role: 'USER', idx: 0, text: 'hi', createdAt: null }]
        }
      })
    )
    input.end()
    await done

    expect(responses).toEqual([{ type: 'INGEST', ok: true, id: 'CHATGPT/c1' }])
  })

  // Why: an oversized frame throws mid-decode inside the 'data' handler, then the
  // stream's natural 'end' event fires right after — finish() must not run twice
  // (double db.close() crashes the host with ERR_INVALID_STATE).
  it('responds with ERROR and shuts down cleanly on an oversized frame', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-host-run-'))
    dirs.push(dir)
    const dbPath = join(dir, 'chats.db')
    const input = new PassThrough()
    const output = new PassThrough()
    const responses: Record<string, unknown>[] = []
    const decoder = new NativeMessageDecoder()
    output.on('data', (chunk: Buffer) => {
      for (const raw of decoder.feed(chunk)) {
        responses.push(JSON.parse(raw))
      }
    })

    const done = runChatImportHost({ input, output, dbPath, now: () => 'now' })
    const header = Buffer.alloc(4)
    header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0)
    input.write(header)
    input.end()

    await expect(done).resolves.toBeUndefined()
    expect(responses.some((r) => r.type === 'ERROR')).toBe(true)
  })
})
