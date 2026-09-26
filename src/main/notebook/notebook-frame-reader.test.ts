import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../resources/notebook/kernel-bridge.py?asset&asarUnpack', () => ({
  default: join(__dirname, '../../../resources/notebook/kernel-bridge.py')
}))

import { createFrameReader } from './notebook-kernel'

function collect(chunks: string[]): unknown[] {
  const frames: unknown[] = []
  const read = createFrameReader((frame) => frames.push(frame))
  for (const chunk of chunks) {
    read(chunk)
  }
  return frames
}

describe('notebook frame reader', () => {
  it('avoids repeatedly scanning an incomplete image record for newlines', () => {
    const frame = { type: 'display_data', content: { data: { 'image/png': 'x'.repeat(524_288) } } }
    const wire = `${JSON.stringify(frame)}\n`
    const chunks: string[] = []
    for (let offset = 0; offset < wire.length; offset += 4096) {
      chunks.push(wire.slice(offset, offset + 4096))
    }
    const originalSplit: { split(separator: unknown, limit?: number): string[] }['split'] =
      String.prototype.split
    const originalIndexOf = String.prototype.indexOf
    let scannedCharacters = 0
    const split = vi.spyOn(String.prototype, 'split').mockImplementation(function (
      this: string,
      separator: unknown,
      limit?: number
    ) {
      if (separator === '\n') {
        scannedCharacters += this.length
      }
      return originalSplit.call(this, separator, limit)
    })
    const indexOf = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      this: string,
      search: string,
      position = 0
    ) {
      const found = originalIndexOf.call(this, search, position)
      if (search === '\n') {
        scannedCharacters += (found === -1 ? this.length : found + 1) - position
      }
      return found
    })
    let frames: unknown[]
    try {
      frames = collect(chunks)
    } finally {
      split.mockRestore()
      indexOf.mockRestore()
    }
    expect(frames).toEqual([frame])
    expect(scannedCharacters).toBeLessThanOrEqual(wire.length * 2)
  })

  it('preserves code units at every split boundary', () => {
    const frames = [
      { type: 'stream', content: { text: 'café 漢字 🐋\n\u0000' } },
      { type: 'execute_result', content: { data: { 'text/plain': '42' } } },
      { type: 'done', status: 'ok', execution_count: 3 }
    ]
    const wire = `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`
    for (let offset = 0; offset <= wire.length; offset++) {
      expect(collect([wire.slice(0, offset), '', wire.slice(offset)])).toEqual(frames)
    }
    expect(collect(wire.split(''))).toEqual(frames)
  })

  it('skips malformed and unsupported records without losing valid neighbors', () => {
    const wire = [
      'startup warning',
      '',
      '  ',
      'null',
      '[]',
      '{"type":"ready"}',
      '{"type":"missing","externallyManaged":true}',
      '{"type":"missing","externallyManaged":"true"}',
      '{"type":"stream","content":[]}',
      '{"type":"unknown","content":{}}',
      '{"type":"done","status":12,"execution_count":"3"}',
      ''
    ].join('\r\n')
    expect(collect([wire])).toEqual([
      { type: 'ready' },
      { type: 'missing', externallyManaged: true },
      { type: 'missing', externallyManaged: false },
      { type: 'done', status: '12', execution_count: null }
    ])
  })

  it('does not apply the shared transport size limit to notebook display data', () => {
    const frame = {
      type: 'display_data',
      content: { data: { 'image/png': 'x'.repeat(16 * 1024 * 1024 + 1) } }
    }
    expect(collect([JSON.stringify(frame), '\n'])).toEqual([frame])
  })

  it('waits for the final newline and retains a suffix behind complete records', () => {
    const frames: unknown[] = []
    const read = createFrameReader((frame) => frames.push(frame))
    read('{"type":"rea')
    expect(frames).toEqual([])
    read('dy"}\n{"type":"missing"}')
    expect(frames).toEqual([{ type: 'ready' }])
    read('')
    expect(frames).toHaveLength(1)
    read('\n')
    expect(frames).toEqual([{ type: 'ready' }, { type: 'missing', externallyManaged: false }])
  })

  it('does not swallow a consumer exception as malformed JSON', () => {
    const error = new Error('consumer failed')
    const read = createFrameReader(() => {
      throw error
    })
    expect(() => read('{"type":"ready"}\n')).toThrow(error)
  })

  it('retains the trailing partial record when an earlier consumer throws', () => {
    const frames: unknown[] = []
    const error = Object.assign(new Error('output failed'), { code: 'EPIPE' })
    const read = createFrameReader((frame) => {
      if (frame.type === 'ready') {
        throw error
      }
      frames.push(frame)
    })
    expect(() => read('{"type":"ready"}\n{"type":"missing"}\n{"type":"do')).toThrow(error)
    read('ne","status":"ok","execution_count":1}\n')
    expect(frames).toEqual([{ type: 'done', status: 'ok', execution_count: 1 }])
  })

  it('preserves the pending suffix before a consumer feeds another chunk', () => {
    const frames: unknown[] = []
    const read = createFrameReader((frame) => {
      frames.push(frame)
      if (frame.type === 'ready') {
        read('ne","status":"ok","execution_count":1}\n')
      }
    })
    read('{"type":"ready"}\n{"type":"missing"}\n{"type":"do')
    expect(frames).toEqual([
      { type: 'ready' },
      { type: 'done', status: 'ok', execution_count: 1 },
      { type: 'missing', externallyManaged: false }
    ])
  })
})
