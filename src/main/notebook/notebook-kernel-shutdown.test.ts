import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { KernelIpcFrame } from '../../shared/notebook-kernel-types'

const { spawnProcessMock } = vi.hoisted(() => ({ spawnProcessMock: vi.fn() }))
vi.mock('@orca/process-host', () => ({ spawnProcess: spawnProcessMock }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  forceTerminateProcessTree: vi.fn()
}))
vi.mock('../../../resources/notebook/kernel-bridge.py?asset&asarUnpack', () => ({
  default: '/bridge.py'
}))

import { type createFrameReader, startNotebookKernel } from './notebook-kernel'

type BridgeFrame = Parameters<Parameters<typeof createFrameReader>[0]>[0]

function fakeChild() {
  const stream = () => Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
    stdout: stream(),
    stderr: stream()
  })
  spawnProcessMock.mockReturnValueOnce(child)
  return child
}

function emit(child: ReturnType<typeof fakeChild>, frame: BridgeFrame): void {
  child.stdout.emit('data', `${JSON.stringify(frame)}\n`)
}

describe('notebook kernel shutdown boundary', () => {
  it.each([false, true])(
    'flushes before stopping and cleans up when notification throws: %s',
    (rejectMarker) => {
      const child = fakeChild()
      const frames: KernelIpcFrame[] = []
      const { kernel } = startNotebookKernel({
        python: '/py',
        cwd: '/',
        onFrame: (frame) => {
          if (rejectMarker && frame.type === 'stopped') {
            throw new Error('send failed')
          }
          frames.push(frame)
        }
      })
      emit(child, { type: 'ready' })
      emit(child, { type: 'stream', content: { name: 'stdout', text: 'last' } })
      if (rejectMarker) {
        expect(() => kernel.shutdown(true)).toThrow('send failed')
      } else {
        kernel.shutdown(true)
      }
      emit(child, { type: 'stream', content: { name: 'stdout', text: 'late' } })
      expect(frames).toEqual(
        rejectMarker
          ? [
              {
                type: 'outputs',
                outputs: [{ type: 'stream', content: { name: 'stdout', text: 'last' } }]
              }
            ]
          : [
              {
                type: 'outputs',
                outputs: [{ type: 'stream', content: { name: 'stdout', text: 'last' } }]
              },
              { type: 'stopped' }
            ]
      )
      expect(child.stdin.end).toHaveBeenCalledOnce()
      child.emit('close', 0)
    }
  )
})
