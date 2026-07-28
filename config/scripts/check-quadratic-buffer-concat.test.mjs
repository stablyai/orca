import { describe, expect, it } from 'vitest'

import { reportQuadraticBufferConcat } from './check-quadratic-buffer-concat.mjs'

describe('check-quadratic-buffer-concat', () => {
  it('reports an accumulator rebuilt from itself in a for-of loop', () => {
    const reports = reportQuadraticBufferConcat(
      'Example.ts',
      'let acc = Buffer.alloc(0); for (const chunk of chunks) { acc = Buffer.concat([acc, chunk]) }'
    )

    expect(reports).toHaveLength(1)
    expect(reports[0].accumulator).toBe('acc')
  })

  it('reports the accumulator when it trails the new chunk', () => {
    const reports = reportQuadraticBufferConcat(
      'Example.ts',
      'let acc = Buffer.alloc(0); for (const chunk of chunks) { acc = Buffer.concat([chunk, acc]) }'
    )

    expect(reports).toHaveLength(1)
  })

  it('reports a spread of the accumulator into its own concat', () => {
    const reports = reportQuadraticBufferConcat(
      'Example.ts',
      'let acc = Buffer.alloc(0); for (const chunk of chunks) { acc = Buffer.concat([...acc, chunk]) }'
    )

    expect(reports).toHaveLength(1)
  })

  it('reports the real pre-fix ai-vault stream carry', () => {
    const reports = reportQuadraticBufferConcat(
      'session-scanner-parse-cache.ts',
      `async function read(stream) {
         let remainder = null
         for await (const chunk of stream) {
           const data = remainder ? Buffer.concat([remainder, chunk]) : chunk
           remainder = Buffer.from(data.subarray(lineStart))
         }
       }`
    )

    expect(reports).toHaveLength(1)
    expect(reports[0].accumulator).toBe('remainder')
  })

  it('reports the real pre-fix transcript reader carry, which never names itself on the left', () => {
    const reports = reportQuadraticBufferConcat(
      'agent-hook-listener.ts',
      `function read(fd, size) {
         let carryBytes = Buffer.alloc(0)
         while (bytesRead < size) {
           const combined = Buffer.concat([buffer.subarray(0, n), carryBytes])
           carryBytes = combined.subarray(0, firstNewline)
         }
       }`
    )

    expect(reports).toHaveLength(1)
    expect(reports[0].accumulator).toBe('carryBytes')
  })

  it('accepts the chunk-list fix that joins once after the loop', () => {
    const reports = reportQuadraticBufferConcat(
      'Example.ts',
      'const parts = []; for (const chunk of chunks) { parts.push(chunk) } const out = Buffer.concat(parts)'
    )

    expect(reports).toHaveLength(0)
  })

  it('accepts spreading a carry chunk list, which is the sanctioned fix', () => {
    const reports = reportQuadraticBufferConcat(
      'Example.ts',
      `let carryChunks = []
       while (scanEnd > 0) {
         const region = carryChunks.length === 0 ? buffer : Buffer.concat([buffer, ...carryChunks])
         carryChunks = [buffer.subarray(0, firstNewline)]
       }`
    )

    expect(reports).toHaveLength(0)
  })

  it('accepts a concat whose result never outlives the iteration', () => {
    const reports = reportQuadraticBufferConcat(
      'Example.ts',
      'for (const group of groups) { const frame = Buffer.concat([group.header, group.body]); send(frame) }'
    )

    expect(reports).toHaveLength(0)
  })

  it('accepts a loop-local buffer declared and rebuilt inside the same iteration', () => {
    const reports = reportQuadraticBufferConcat(
      'Example.ts',
      'for (const chunk of chunks) { let framed = HEADER; framed = Buffer.concat([framed, chunk]); send(framed) }'
    )

    expect(reports).toHaveLength(0)
  })

  it('reports an accumulator declared in a classic for initializer', () => {
    const reports = reportQuadraticBufferConcat(
      'Example.ts',
      'for (let acc = Buffer.alloc(0), i = 0; i < n; i++) { acc = Buffer.concat([acc, chunks[i]]) }'
    )

    expect(reports).toHaveLength(1)
  })

  it('reports a class field accumulator rebuilt inside a loop', () => {
    const reports = reportQuadraticBufferConcat(
      'Example.ts',
      'class Reader { read() { while (this.open) { this.pending = Buffer.concat([this.pending, chunk]) } } }'
    )

    expect(reports).toHaveLength(1)
    expect(reports[0].accumulator).toBe('this.pending')
  })

  it('reports an accumulator guarded by an emptiness ternary', () => {
    const reports = reportQuadraticBufferConcat(
      'Example.ts',
      'let acc = Buffer.alloc(0); while (open) { acc = acc.length === 0 ? chunk : Buffer.concat([acc, chunk]) }'
    )

    expect(reports).toHaveLength(1)
  })

  it('ignores a per-event accumulator with no enclosing loop', () => {
    const reports = reportQuadraticBufferConcat(
      'scrcpy-stream-session.ts',
      'class S { handleVideoChunk(chunk) { let buffer = Buffer.concat([this.pendingVideo, chunk]); this.pendingVideo = parse(buffer).pending } }'
    )

    expect(reports).toHaveLength(0)
  })

  it('ignores files with no Buffer.concat at all', () => {
    expect(reportQuadraticBufferConcat('Example.ts', 'export const x = 1')).toHaveLength(0)
  })
})
