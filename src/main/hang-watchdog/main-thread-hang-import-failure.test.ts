import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MainToHangWatchdogWorkerMessage } from './hang-watchdog-worker-protocol'

const state = vi.hoisted(() => ({ records: new Array<unknown>() }))
vi.mock('node:worker_threads', () => ({ isMainThread: false, parentPort: null, workerData: null }))
vi.mock('node:inspector', () => ({
  Session: class {
    connectToMainThread() {}
    disconnect() {}
    post(method: string, _params: unknown, response: (error: null, result?: unknown) => void) {
      response(
        null,
        method === 'Profiler.stop'
          ? { profile: { nodes: [], samples: [], startTime: 0, endTime: 1 } }
          : undefined
      )
    }
  }
}))
vi.mock('@orca/process-host', () => {
  throw new Error('native dependency unavailable before runner acquisition')
})
vi.mock('./hang-detection-marker', () => ({
  readAvailableHangDetectionMarker: () => null,
  writeHangDetectionMarker: (_path: string, record: unknown) => {
    state.records.push(structuredClone(record))
  }
}))
vi.mock('./hang-incident-snapshot', () => ({
  readCompletedHangContext: () => null,
  collectHangMachineSnapshot: async () => null
}))
import { runWatchdog } from './main-thread-hang-watchdog-entry'

beforeEach(() => {
  state.records = []
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('preserves later JS capture and waits for its drain when the native module cannot load', async () => {
  let send: (message: MainToHangWatchdogWorkerMessage) => void = () => {}
  let token = ''
  let closed = false
  runWatchdog(
    {
      parentPid: 123,
      markerPath: '/qa/main-thread-hang.json',
      timeoutMs: 100,
      checkIntervalMs: 25
    },
    {
      on: (_event, listener) => {
        send = listener
      },
      close: () => {
        closed = true
      },
      postMessage: (message) => {
        token = message.token
      }
    }
  )
  await vi.advanceTimersByTimeAsync(125)
  await vi.dynamicImportSettled()
  expect(state.records.at(-1)).toMatchObject({
    observations: [
      expect.objectContaining({
        mainJs: expect.objectContaining({ state: 'collecting' }),
        native: expect.objectContaining({ state: 'failed', cleanup: 'unverified', stacks: [] })
      })
    ]
  })
  send({ type: 'heartbeat' })
  await vi.dynamicImportSettled()
  send({ type: 'capture-drain-ack', token })
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(125)
  await vi.dynamicImportSettled()
  expect(state.records.at(-1)).toMatchObject({
    observations: [
      expect.anything(),
      expect.objectContaining({
        mainJs: expect.objectContaining({ state: 'collecting' }),
        native: expect.objectContaining({ state: 'failed', cleanup: 'unverified', stacks: [] })
      })
    ]
  })
  send({ type: 'shutdown' })
  await vi.dynamicImportSettled()
  expect(closed).toBe(false)
  expect(state.records.at(-1)).toMatchObject({
    observations: [
      expect.anything(),
      expect.objectContaining({
        mainJs: expect.objectContaining({ cleanup: 'pending', stopReason: 'shutdown' })
      })
    ]
  })
  send({ type: 'capture-drain-ack', token })
  await vi.dynamicImportSettled()
  expect(closed).toBe(true)
})
