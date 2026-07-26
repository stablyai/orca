import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  appendProcessOutputTail,
  attachBoundedProcessLineReader,
  PROCESS_LINE_MAX_BYTES
} from '../../scripts/bounded-process-line-reader.mjs'

describe('attachBoundedProcessLineReader', () => {
  it('preserves ordinary LF, CRLF, and split UTF-8 lines', () => {
    const stream = new PassThrough()
    const lines: string[] = []
    attachBoundedProcessLineReader(stream, (line) => lines.push(line))

    const unicode = Buffer.from('café\n')
    stream.write('first\r\nsecond\r')
    stream.write('\n')
    stream.write(unicode.subarray(0, -2))
    stream.end(unicode.subarray(-2))

    expect(lines).toEqual(['first', 'second', 'café'])
  })

  it('retains only the configured prefix of an unterminated line', async () => {
    const stream = new PassThrough()
    const lines: string[] = []
    attachBoundedProcessLineReader(stream, (line) => lines.push(line), 4)

    const ended = once(stream, 'end')
    stream.end('abcdefgh')
    await ended

    expect(lines).toEqual(['abcd… [line truncated]'])
  })

  it('uses a bounded default for process output lines', () => {
    expect(PROCESS_LINE_MAX_BYTES).toBe(64 * 1024)
  })

  it('keeps exact output below the tail cap and newest output above it', () => {
    expect(appendProcessOutputTail('first\n', 'second', 32)).toBe('first\nsecond\n')
    expect(appendProcessOutputTail('first\n', 'second', 8)).toBe('\nsecond\n')
    expect(appendProcessOutputTail('first\n', 'second', 0)).toBe('')
  })
})
