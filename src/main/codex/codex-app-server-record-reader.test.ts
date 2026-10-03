import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_APP_SERVER_MAX_RECORD_BYTES,
  createCodexAppServerRecordReader
} from './codex-app-server-record-reader'

function setup() {
  const stdout = new PassThrough()
  const onRecord = vi.fn()
  const onRejected = vi.fn()
  const onFatal = vi.fn()
  const reader = createCodexAppServerRecordReader({ stdout, onRecord, onRejected, onFatal })
  return { stdout, reader, onRecord, onRejected, onFatal }
}

describe('Codex record admission', () => {
  it('fails once before an unterminated record can retain unbounded input', () => {
    const { stdout, reader, onRecord, onRejected, onFatal } = setup()
    const chunk = 'x'.repeat(1024 * 1024)
    for (let index = 0; index <= CODEX_APP_SERVER_MAX_RECORD_BYTES / chunk.length; index++) {
      stdout.emit('data', chunk)
    }
    expect(onFatal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: 'NdjsonLineTooLongError',
        maxLineBytes: CODEX_APP_SERVER_MAX_RECORD_BYTES
      })
    )
    expect(stdout.isPaused()).toBe(true)
    reader.resume()
    stdout.emit('data', '\n{"id":1}\n')
    expect(onRecord).not.toHaveBeenCalled()
    expect(onRejected).not.toHaveBeenCalled()
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(stdout.isPaused()).toBe(true)
    stdout.destroy()
  })

  it('delivers a multibyte record at the exact byte limit without clipping', () => {
    const { stdout, onRecord, onFatal } = setup()
    const body = 'é'.repeat((CODEX_APP_SERVER_MAX_RECORD_BYTES - 2) / 2)
    stdout.emit('data', '"')
    for (let offset = 0; offset < body.length; offset += 65536) {
      stdout.emit('data', body.slice(offset, offset + 65536))
    }
    stdout.emit('data', '"\n')
    expect(onRecord).toHaveBeenCalledExactlyOnceWith(body, `"${body}"`)
    expect(onFatal).not.toHaveBeenCalled()
    stdout.destroy()
  })

  it('fails safely when resumed queued input exceeds the record cap', () => {
    const { stdout, reader, onFatal, onRecord } = setup()
    onRecord.mockImplementationOnce(() => reader.pause())
    const oversized = 'x'.repeat(CODEX_APP_SERVER_MAX_RECORD_BYTES + 1)
    stdout.emit('data', `{}\n${oversized}\n`)
    expect(onFatal).not.toHaveBeenCalled()
    reader.resume()
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onRecord).toHaveBeenCalledTimes(1)
    expect(stdout.isPaused()).toBe(true)
    stdout.destroy()
  })
})
