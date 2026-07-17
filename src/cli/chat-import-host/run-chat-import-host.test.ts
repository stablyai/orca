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

  // Why: a response can exceed Chrome's 1 MB outbound limit (e.g. a large
  // INGESTED_IDS list). encodeNativeMessage throws on such a payload; the host
  // must answer ERROR rather than let the exception crash it mid-'data'.
  it('responds with ERROR instead of crashing when a response exceeds the outbound limit', async () => {
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
    // PING echoes _id back; an oversized _id pushes the PONG response past the
    // 1 MB outbound limit, so encoding it throws. The inbound frame is built by
    // hand because encodeNativeMessage itself enforces the outbound cap.
    const payload = Buffer.from(
      JSON.stringify({ type: 'PING', _id: 'x'.repeat(1024 * 1024 + 64) }),
      'utf8'
    )
    const header = Buffer.alloc(4)
    header.writeUInt32LE(payload.length, 0)
    input.write(Buffer.concat([header, payload]))
    input.end()

    await expect(done).resolves.toBeUndefined()
    expect(responses.some((r) => r.type === 'ERROR')).toBe(true)
  })
})
