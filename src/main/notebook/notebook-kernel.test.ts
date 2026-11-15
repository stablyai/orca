import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { KernelFrame } from '../../shared/notebook-kernel-types'

vi.mock('../../../resources/notebook/kernel-bridge.py?asset&asarUnpack', () => ({
  default: join(__dirname, '../../../resources/notebook/kernel-bridge.py')
}))

import { startNotebookKernel } from './notebook-kernel'

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
    expect(JSON.stringify(death)).not.toContain('without encryption')
  }, 60_000)
})
