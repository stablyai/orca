import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MainToHangWatchdogWorkerMessage } from './hang-watchdog-worker-protocol'

const state = vi.hoisted(() => ({
  clock: 0,
  delayedWrite: false,
  rejectRunner: false,
  parkedStop: false,
  successfulNative: false,
  artifacts: new Array<{ showMenuBarIcon: boolean | null }>(),
  commands: new Array<string>(),
  terminations: new Array<() => void>(),
  records: new Array<unknown>()
}))
vi.mock('node:worker_threads', () => ({ isMainThread: false, parentPort: null, workerData: null }))
vi.mock('node:inspector', () => ({
  Session: class {
    connectToMainThread() {}
    disconnect() {}
    post(
      method: string,
      _params: unknown,
      response: (error: Error | null, result?: unknown) => void
    ) {
      state.commands.push(method)
      if (method === 'Profiler.stop' && state.parkedStop) {
        response(new Error('uncertain inspector transport'))
        return
      }
      response(
        null,
        method === 'Profiler.stop'
          ? { profile: { nodes: [], samples: [], startTime: 0, endTime: 1 } }
          : undefined
      )
    }
  }
}))
vi.mock('@orca/process-host', () => ({
  runProcess: async (options: { onChildTerminated: () => void }) => {
    state.terminations.push(options.onChildTerminated)
    if (state.rejectRunner) {
      throw new Error('runner rejected after possible acquisition')
    }
    if (state.successfulNative) {
      options.onChildTerminated()
      return { stdout: 'native evidence', stderr: '', code: 0, timedOut: false }
    }
    return { stdout: '', stderr: '', code: null, timedOut: true }
  }
}))
vi.mock('./native-hang-capture-store', () => ({
  createNativeHangCaptureId: (time: number) => `hang-${time}`,
  NativeHangCaptureStore: class {
    async save(artifact: { showMenuBarIcon: boolean | null }) {
      state.artifacts.push(structuredClone(artifact))
    }
    async recover() {}
  }
}))
vi.mock('./hang-detection-marker', () => ({
  readAvailableHangDetectionMarker: () => null,
  writeHangDetectionMarker: (_path: string, record: unknown) => {
    state.records.push(structuredClone(record))
    if (state.delayedWrite) {
      state.clock = 6000
    }
  }
}))
vi.mock('./hang-incident-snapshot', () => ({
  readCompletedHangContext: () => null,
  collectHangMachineSnapshot: async () => null
}))
import { runWatchdog } from './main-thread-hang-watchdog-entry'

beforeEach(() => {
  state.clock = 0
  state.delayedWrite = false
  state.rejectRunner = false
  state.parkedStop = false
  state.successfulNative = false
  state.artifacts = []
  state.commands = []
  state.terminations = []
  state.records = []
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.spyOn(performance, 'now').mockImplementation(() => state.clock)
})
afterEach(() => {
  for (const terminate of state.terminations.splice(0)) {
    terminate()
  }
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
function watchdog() {
  let message: (value: MainToHangWatchdogWorkerMessage) => void = () => {}
  runWatchdog(
    {
      parentPid: 123,
      markerPath: '/qa/main-thread-hang.json',
      artifactDirectory: '/qa/captures',
      processMetadata: {
        appVersion: '1',
        electronVersion: '43',
        chromeVersion: '150',
        arch: 'arm64',
        osRelease: '25',
        osVersion: 'Darwin'
      },
      timeoutMs: 100,
      checkIntervalMs: 25
    },
    {
      on: (_event, listener) => {
        message = listener
      },
      close: () => {},
      postMessage: (value) => message({ type: 'capture-drain-ack', token: value.token })
    }
  )
  return { send: (value: MainToHangWatchdogWorkerMessage) => message(value) }
}
it('does not start a profiler after baseline publication has exhausted the detection budget', async () => {
  state.delayedWrite = true
  const owner = watchdog()
  await vi.advanceTimersByTimeAsync(125)
  await vi.dynamicImportSettled()
  expect(state.commands).toEqual(['Profiler.enable', 'Profiler.disable'])
  expect(state.records.at(-1)).toMatchObject({
    observations: [
      expect.objectContaining({
        mainJs: expect.objectContaining({
          state: 'not-started',
          stopReason: 'deadline',
          stopRequestedAfterDetectionMs: 6000
        })
      })
    ]
  })
  owner.send({ type: 'shutdown' })
})
it.each([false, true])(
  'retains possible native ownership until a late termination receipt (runner rejects: %s)',
  async (rejectRunner) => {
    state.rejectRunner = rejectRunner
    const owner = watchdog()
    await vi.advanceTimersByTimeAsync(125)
    await vi.dynamicImportSettled()
    owner.send({ type: 'heartbeat' })
    await vi.dynamicImportSettled()
    expect(state.records.at(-1)).toMatchObject({
      observations: [
        expect.objectContaining({ native: expect.objectContaining({ cleanup: 'unverified' }) })
      ]
    })
    await vi.advanceTimersByTimeAsync(125)
    await vi.dynamicImportSettled()
    expect(state.records.at(-1)).toMatchObject({
      observations: [expect.anything(), expect.not.objectContaining({ native: expect.anything() })]
    })
    owner.send({ type: 'heartbeat' })
    state.terminations.shift()?.()
    await vi.dynamicImportSettled()
    expect(state.records.at(-1)).toMatchObject({
      observations: [
        expect.objectContaining({ native: expect.objectContaining({ cleanup: 'terminated' }) }),
        expect.anything()
      ]
    })
    await vi.advanceTimersByTimeAsync(125)
    await vi.dynamicImportSettled()
    expect(state.records.at(-1)).toMatchObject({
      observations: [
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          mainJs: expect.objectContaining({ state: 'collecting' }),
          native: expect.objectContaining({
            state: rejectRunner ? 'failed' : 'completed',
            cleanup: 'unverified'
          })
        })
      ]
    })
    owner.send({ type: 'shutdown' })
  }
)

it('captures a later native episode while the earlier inspector cleanup remains uncertain', async () => {
  state.parkedStop = true
  const owner = watchdog()
  await vi.advanceTimersByTimeAsync(125)
  await vi.dynamicImportSettled()
  state.terminations.shift()?.()
  owner.send({ type: 'heartbeat' })
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(125)
  await vi.dynamicImportSettled()
  expect(state.records.at(-1)).toMatchObject({
    observations: [
      expect.objectContaining({ mainJs: expect.objectContaining({ state: 'failed' }) }),
      expect.objectContaining({ native: expect.objectContaining({ state: 'completed' }) })
    ]
  })
  owner.send({ type: 'shutdown' })
})

it('snapshots only the setting actually received before each episode', async () => {
  state.successfulNative = true
  const owner = watchdog()
  await vi.advanceTimersByTimeAsync(125)
  await vi.dynamicImportSettled()
  owner.send({ type: 'heartbeat' })
  owner.send({ type: 'menu-bar-setting', enabled: false })
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(125)
  await vi.dynamicImportSettled()
  owner.send({ type: 'menu-bar-setting', enabled: true })
  expect(state.artifacts.map((item) => item.showMenuBarIcon)).toEqual([null, false])
  owner.send({ type: 'heartbeat' })
  await vi.dynamicImportSettled()
  await vi.advanceTimersByTimeAsync(125)
  await vi.dynamicImportSettled()
  expect(state.artifacts.map((item) => item.showMenuBarIcon)).toEqual([null, false, true])
  owner.send({ type: 'shutdown' })
})
