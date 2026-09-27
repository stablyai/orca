import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { KernelFrame } from '../../shared/notebook-kernel-types'

vi.mock('../../../resources/notebook/kernel-bridge.py?asset&asarUnpack', () => ({
  default: join(__dirname, '../../../resources/notebook/kernel-bridge.py')
}))

import { createFrameReader, startNotebookKernel } from './notebook-kernel'

function collect(chunks: string[]): unknown[] {
  const frames: unknown[] = []
  const read = createFrameReader((frame) => frames.push(frame))
  for (const chunk of chunks) {
    read(chunk)
  }
  return frames
}

describe('createFrameReader', () => {
  it('reassembles frames split across chunks and skips stray lines', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(
        collect([
          'warning: something printed\n{"type": "rea',
          'dy"}\n{"type": "stream", "content": {"name": "stdout", "text": "hi"}}\n[1, 2]\n',
          '{"type": "missing", "externallyManaged": true}\n{"type": "missing"}\n',
          '{"type": "unknown"}\n{"type": "done", "status": "ok", "execution_count": 3}\n{"partial'
        ])
      ).toEqual([
        { type: 'ready' },
        { type: 'stream', content: { name: 'stdout', text: 'hi' } },
        { type: 'missing', externallyManaged: true },
        { type: 'missing', externallyManaged: false },
        { type: 'done', status: 'ok', execution_count: 3 }
      ])
    } finally {
      warn.mockRestore()
    }
  })

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

  it('does not measure record bytes when no size limit applies', () => {
    const frame = { type: 'display_data', content: { data: { 'image/png': 'x'.repeat(65_536) } } }
    const byteLength = vi.spyOn(Buffer, 'byteLength')
    let frames: unknown[]
    let measurements: number
    try {
      frames = collect([`${JSON.stringify(frame)}\n`])
      measurements = byteLength.mock.calls.length
    } finally {
      byteLength.mockRestore()
    }
    expect(frames).toEqual([frame])
    expect(measurements).toBe(0)
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let frames: unknown[]
    let reported: number
    try {
      frames = collect([wire])
      reported = warn.mock.calls.length
    } finally {
      warn.mockRestore()
    }
    expect(frames).toEqual([
      { type: 'ready' },
      { type: 'missing', externallyManaged: true },
      { type: 'missing', externallyManaged: false },
      { type: 'done', status: '12', execution_count: null }
    ])
    // The unreadable line is reported; a parsed record of an unknown shape is not.
    expect(reported).toBe(1)
  })

  it('does not apply the shared transport size limit to notebook display data', () => {
    const frame = {
      type: 'display_data',
      content: { data: { 'image/png': 'x'.repeat(16 * 1024 * 1024 + 1) } }
    }
    expect(collect([JSON.stringify(frame), '\n'])).toEqual([frame])
  })

  it('waits for the final newline before delivering a record', () => {
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

  it('holds a never-terminated record without emitting or rejecting it', () => {
    const frames: unknown[] = []
    const text = 'x'.repeat(200_000)
    const wire = JSON.stringify({ type: 'stream', content: { name: 'stdout', text } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const read = createFrameReader((frame) => frames.push(frame))
    try {
      for (let offset = 0; offset < wire.length; offset += 4096) {
        read(wire.slice(offset, offset + 4096))
      }
      expect(frames).toEqual([])
      expect(warn).not.toHaveBeenCalled()
      read('\n')
    } finally {
      warn.mockRestore()
    }
    expect(frames).toEqual([{ type: 'stream', content: { name: 'stdout', text } }])
  })

  it('does not swallow a consumer exception as malformed JSON', () => {
    const error = new Error('consumer failed')
    const read = createFrameReader(() => {
      throw error
    })
    expect(() => read('{"type":"ready"}\n')).toThrow(error)
  })
})

// Needs an interpreter with ipykernel, e.g. ORCA_TEST_IPYKERNEL_PYTHON=/path/to/.venv/bin/python.
const python = process.env.ORCA_TEST_IPYKERNEL_PYTHON

describe.skipIf(!python)('notebook kernel against a real ipykernel', () => {
  it('keeps state across cells, returns the last expression, interrupts, and reports death', async () => {
    const frames: KernelFrame[] = []
    let onFrame: () => void = () => {}
    const next = (type: KernelFrame['type']): Promise<KernelFrame> =>
      new Promise((resolve) => {
        onFrame = () => {
          const index = frames.findIndex((frame) => frame.type === type)
          if (index !== -1) {
            resolve(frames.splice(0, index + 1)[index])
          }
        }
        onFrame()
      })
    const { kernel, ready } = startNotebookKernel({
      python: python!,
      cwd: __dirname,
      onFrame: (frame) => {
        frames.push(frame)
        onFrame()
      }
    })
    expect(await ready).toEqual({ status: 'ready' })

    kernel.execute('x = 41\nprint("hi")')
    expect(await next('done')).toMatchObject({ status: 'ok', execution_count: 1 })
    kernel.execute('x + 1')
    expect(await next('execute_result')).toMatchObject({
      content: { data: { 'text/plain': '42' } }
    })
    await next('done')

    kernel.execute('import time\nwhile True: time.sleep(0.05)')
    setTimeout(() => kernel.interrupt(), 500)
    expect(await next('error')).toMatchObject({ content: { ename: 'KeyboardInterrupt' } })
    expect(await next('done')).toMatchObject({ status: 'error' })

    kernel.execute('import os; os._exit(1)')
    const death = await next('exit')
    expect(death).toMatchObject({ type: 'exit' })
    // ipykernel's startup warning about unencrypted TCP is not why it died.
    expect(JSON.stringify(death)).not.toContain('without encryption')
  }, 60_000)
})

const bare = process.env.ORCA_TEST_PYTHON_WITHOUT_IPYKERNEL

describe.skipIf(!bare)('notebook kernel without ipykernel', () => {
  it('reports the missing package instead of starting', async () => {
    const { ready } = startNotebookKernel({ python: bare!, cwd: __dirname, onFrame: () => {} })
    // A bare venv accepts pip installs, whatever its base interpreter does.
    expect(await ready).toEqual({ status: 'missing-ipykernel', externallyManaged: false })
  })
})
