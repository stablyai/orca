import { expect, it, vi } from 'vitest'
import { captureMainJsHang } from './main-js-hang-capture'
import type { MainJsCapture } from './hang-stacks'

function fixture() {
  let callback: ((error: Error | null, result?: unknown) => void) | undefined
  const commands: string[] = []
  const disconnect = vi.fn()
  let finishDrain: (() => void) | undefined
  const records: MainJsCapture[] = []
  const capture = captureMainJsHang({
    session: {
      connectToMainThread: () => {},
      disconnect,
      post: (method, _params, response) => {
        commands.push(method)
        callback = response
      }
    },
    detectedAt: 0,
    now: () => 100,
    publish: (record) => records.push(record),
    drain: () =>
      new Promise<void>((resolve) => {
        finishDrain = resolve
      })
  })
  const acknowledge = async (result?: unknown, error: Error | null = null): Promise<void> => {
    const response = callback
    callback = undefined
    response?.(error, result)
    await Promise.resolve()
    await Promise.resolve()
  }
  return { capture, commands, disconnect, records, acknowledge, drain: () => finishDrain?.() }
}

it('does not start after recovery while enable is pending, and drains only after disable acknowledgement', async () => {
  const f = fixture()
  f.capture.stop('recovery')
  expect(f.disconnect).not.toHaveBeenCalled()
  await f.acknowledge()
  expect(f.commands).toEqual(['Profiler.enable', 'Profiler.disable'])
  expect(f.disconnect).not.toHaveBeenCalled()
  await f.acknowledge()
  expect(f.disconnect).toHaveBeenCalledOnce()
  expect(f.records.at(-1)?.cleanup).toBe('pending')
  f.drain()
  await f.capture.done
  expect(f.records.at(-1)).toMatchObject({
    state: 'not-started',
    cleanup: 'drain-complete',
    stopReason: 'recovery'
  })
})

it('owns a posted start and its stop through shutdown without racing disconnect', async () => {
  const f = fixture()
  await f.acknowledge()
  await f.acknowledge()
  expect(f.commands).toEqual(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start'])
  f.capture.stop('shutdown')
  await f.acknowledge()
  expect(f.commands.at(-1)).toBe('Profiler.stop')
  expect(f.disconnect).not.toHaveBeenCalled()
  await f.acknowledge({ profile: { nodes: [], samples: [], startTime: 1000, endTime: 3000 } })
  expect(f.commands.at(-1)).toBe('Profiler.disable')
  expect(f.disconnect).not.toHaveBeenCalled()
  await f.acknowledge()
  f.drain()
  await f.capture.done
  expect(f.records.at(-1)).toMatchObject({
    state: 'completed',
    profileDurationMs: 2,
    cleanup: 'drain-complete',
    stopReason: 'shutdown'
  })
})

it('does not disconnect or release an owner after stop fails', async () => {
  const f = fixture()
  await f.acknowledge()
  await f.acknowledge()
  await f.acknowledge()
  f.capture.stop('recovery')
  await Promise.resolve()
  await f.acknowledge(undefined, new Error('stop rejected'))
  expect(f.commands.at(-1)).toBe('Profiler.stop')
  expect(f.disconnect).not.toHaveBeenCalled()
  expect(f.records.at(-1)).toMatchObject({ state: 'failed', cleanup: 'pending' })
})
