import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { KernelFrame } from '../../shared/notebook-kernel-types'

vi.mock('../../../resources/notebook/kernel-bridge.py?asset&asarUnpack', () => ({
  default: join(__dirname, '../../../resources/notebook/kernel-bridge.py')
}))

import { createFrameReader, startNotebookKernel } from './notebook-kernel'

describe('createFrameReader', () => {
  it('reassembles frames split across chunks and skips stray lines', () => {
    const frames: unknown[] = []
    const read = createFrameReader((frame) => frames.push(frame))
    read('warning: something printed\n{"type": "rea')
    read('dy"}\n{"type": "stream", "content": {"name": "stdout", "text": "hi"}}\n[1, 2]\n')
    read('{"type": "missing", "externallyManaged": true}\n{"type": "missing"}\n')
    read('{"type": "unknown"}\n{"type": "done", "status": "ok", "execution_count": 3}\n{"partial')
    expect(frames).toEqual([
      { type: 'ready' },
      { type: 'stream', content: { name: 'stdout', text: 'hi' } },
      { type: 'missing', externallyManaged: true },
      { type: 'missing', externallyManaged: false },
      { type: 'done', status: 'ok', execution_count: 3 }
    ])
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
