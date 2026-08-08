import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { TerminalBridgeNdjsonReader, TerminalBridgeNdjsonWriter } from './terminal-bridge-ndjson'

class GatedWritable extends Writable {
  readonly writes: string[] = []
  readonly releases: (() => void)[] = []

  constructor() {
    super({ highWaterMark: 1 })
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.writes.push(chunk.toString())
    this.releases.push(callback)
  }
}

describe('terminal bridge NDJSON I/O', () => {
  it('rejects an unterminated input frame before retaining beyond the byte limit', async () => {
    const input = new PassThrough()
    const errors: Error[] = []
    new TerminalBridgeNdjsonReader({
      input,
      onLine: vi.fn(),
      onEnd: vi.fn(),
      onError: (error) => errors.push(error),
      maxFrameBytes: 8
    })

    input.write('123456789')
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]?.message).toContain('maximum size')
    expect(input.isPaused()).toBe(true)
  })

  it('bounds complete input frames while an earlier frame is still processing', async () => {
    const input = new PassThrough()
    const errors: Error[] = []
    let release = (): void => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    new TerminalBridgeNdjsonReader({
      input,
      onLine: () => blocked,
      onEnd: vi.fn(),
      onError: (error) => errors.push(error),
      maxFrameBytes: 8,
      maxQueueBytes: 8
    })

    input.write('one\ntwo\ntri\nfour\n')
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]?.message).toContain('queue')
    release()
  })

  it('drains a final unterminated frame before reporting stdin EOF', async () => {
    const input = new PassThrough()
    const order: string[] = []
    new TerminalBridgeNdjsonReader({
      input,
      onLine: async (line) => {
        await Promise.resolve()
        order.push(`line:${line}`)
      },
      onEnd: () => order.push('end'),
      onError: vi.fn()
    })

    input.end('{"type":"close"}')

    await vi.waitFor(() => expect(order).toEqual(['line:{"type":"close"}', 'end']))
  })

  it('resumes bounded output after the destination drains', async () => {
    const output = new GatedWritable()
    const errors: Error[] = []
    const writer = new TerminalBridgeNdjsonWriter({
      output,
      onError: (error) => errors.push(error),
      maxPendingBytes: 1024
    })

    expect(writer.write({ type: 'data', chunk: 'one' })).toBe(true)
    expect(writer.write({ type: 'data', chunk: 'two' })).toBe(true)
    expect(output.writes).toHaveLength(1)

    output.releases.shift()?.()
    await vi.waitFor(() => expect(output.writes).toHaveLength(2))
    output.releases.shift()?.()
    await writer.finish()
    expect(errors).toEqual([])
  })

  it('fails instead of growing an unbounded output queue', async () => {
    const output = new GatedWritable()
    const errors: Error[] = []
    const writer = new TerminalBridgeNdjsonWriter({
      output,
      onError: (error) => errors.push(error),
      maxPendingBytes: 80
    })

    expect(writer.write({ type: 'data', chunk: 'a'.repeat(30) })).toBe(true)
    expect(writer.write({ type: 'data', chunk: 'b'.repeat(30) })).toBe(false)
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]?.message).toContain('backpressure')
    expect(output.writableLength).toBeLessThanOrEqual(80)
    output.releases.shift()?.()
  })
})
