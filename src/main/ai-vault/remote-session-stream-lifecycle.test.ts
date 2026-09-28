import { describe, it, expect, vi } from 'vitest'
import { streamedSessionContentLines } from './remote-session-content-lines'
import { readStreamedSessionDocument } from './session-document-stream'
import { limitRemoteScanFilesystemConcurrency } from './remote-session-scan-concurrency'

describe('stream lifetime and retained document work', () => {
  it('aborts a newline-free record at the byte ceiling and closes the source', async () => {
    let closed = false
    let reads = 0
    async function* bytes() {
      const chunk = Buffer.alloc(1024 * 1024, 'x')
      try {
        for (; reads < 100;) {
          reads++
          yield chunk
        }
      } finally {
        closed = true
      }
    }
    const lines = streamedSessionContentLines(bytes())
    await expect(lines.next()).rejects.toThrow('record exceeds 10485760 byte limit')
    expect(reads).toBe(11)
    expect(closed).toBe(true)
  })

  it('releases the source when a line consumer finishes early', async () => {
    let closed = false
    async function* bytes() {
      try {
        yield Buffer.from('one\ntwo\n')
        yield Buffer.from('three\n')
      } finally {
        closed = true
      }
    }
    for await (const line of streamedSessionContentLines(bytes())) {
      expect(line).toBe('one')
      break
    }
    await vi.waitFor(() => expect(closed).toBe(true))
  })
  it('propagates disk failure and closes the source', async () => {
    let closed = false
    async function* bytes() {
      try {
        yield Buffer.from('one\n')
        throw new Error('disk read failed')
      } finally {
        closed = true
      }
    }
    await expect(
      (async () => {
        for await (const _ of streamedSessionContentLines(bytes())) {
          /* consume */
        }
      })()
    ).rejects.toThrow('disk read failed')
    expect(closed).toBe(true)
  })
  it('cancellation discards a document fold and releases its source', async () => {
    const controller = new AbortController()
    let closed = false
    async function* bytes() {
      try {
        yield Buffer.from('{"messages":[{"role":"user"}')
        controller.abort()
        yield Buffer.from(']}')
      } finally {
        closed = true
      }
    }
    await expect(
      readStreamedSessionDocument({
        bytes: bytes(),
        arrayKey: 'messages',
        fields: [],
        create: () => ({ count: 0 }),
        consume: (state) => {
          state.count++
        },
        signal: controller.signal
      })
    ).rejects.toThrow()
    expect(closed).toBe(true)
  })
  it('holds one filesystem slot for the stream lifetime and releases it on return', async () => {
    let entered = 0
    async function* bytes() {
      entered++
      yield Buffer.from('a')
      yield Buffer.from('b')
    }
    const provider = limitRemoteScanFilesystemConcurrency(
      {
        readDir: async () => [],
        readFile: async () => ({ content: '', isBinary: false }),
        stat: async () => ({ size: 0, type: 'file', mtime: 0 }),
        readTranscriptBytes: bytes
      },
      1
    )
    const first = provider.readTranscriptBytes!('/one')[Symbol.asyncIterator](),
      second = provider.readTranscriptBytes!('/two')[Symbol.asyncIterator]()
    await first.next()
    const pending = second.next()
    await Promise.resolve()
    expect(entered).toBe(1)
    await first.return!()
    await pending
    expect(entered).toBe(2)
    await second.return!()
  })
})
