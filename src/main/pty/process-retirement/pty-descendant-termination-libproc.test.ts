import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ExecFileCallback = (error: Error | null, stdout?: string) => void
const { execFile } = vi.hoisted(() => ({
  execFile:
    vi.fn<
      (
        file: string,
        args: string[],
        options: { timeout: number },
        callback: ExecFileCallback
      ) => void
    >()
}))
// A native read that times out falls back to ps; keep that fallback from reading the real host.
vi.mock('node:child_process', () => ({ execFile }))
import {
  setLibprocAddonForTests,
  type LibprocProcessRow,
  type LibprocQuery
} from '../../../shared/process-observation/darwin/libproc-addon'
import { resetNativeReadsForTests } from '../../../shared/process-observation/darwin/libproc-native-reads'
import { captureDescendantSnapshot, killWithDescendantSweep } from './pty-descendant-termination'

const START = Date.UTC(2026, 8, 3, 16, 2, 1) / 1000
const WALL_CLOCK = Date.UTC(2026, 9, 29, 12, 0, 0)

function row(pid: number, ppid: number): LibprocProcessRow {
  return {
    pid,
    ppid,
    pgid: pid,
    tpgid: 0,
    tdev: -1,
    status: 3,
    flags: 0,
    sessionLeader: false,
    startSec: START,
    comm: 'node'
  }
}

beforeEach(() => {
  execFile.mockImplementation((_file, _args, _options, callback) =>
    callback(new Error('ps unavailable in this test'))
  )
})

afterEach(() => {
  execFile.mockReset()
  setLibprocAddonForTests(undefined)
  resetNativeReadsForTests()
  vi.useRealTimers()
})

describe('descendant teardown over the in-process process table', () => {
  it.each([
    ['a steady clock', 0],
    ['the wall clock stepped back 100ms', -100],
    ['the wall clock stepped back an hour', -3_600_000],
    ['the wall clock stepped forward an hour', 3_600_000]
  ])(
    'never signals a reused pid from an earlier poll’s abandoned native read with %s',
    async (_name, stepMs) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(WALL_CLOCK)
      type Rows = LibprocProcessRow[] | null
      let finishAbandoned: (rows: Rows) => void = () => {}
      const abandoned = new Promise<Rows>((resolve) => {
        finishAbandoned = resolve
      })
      const readProcessTable = vi
        .fn<(query: LibprocQuery) => Promise<Rows>>()
        .mockReturnValueOnce(abandoned)
        // Since that read was submitted, descendant 200 exited and an unrelated process took its pid.
        .mockImplementation(async () => [row(1, 0), row(100, 1), row(200, 1), row(300, 100)])
      setLibprocAddonForTests({
        readProcessTable,
        readProcessCwd: async () => null,
        readProcessPath: async () => null
      })
      expect(await captureDescendantSnapshot(100, { platform: 'darwin', timeoutMs: 10 })).toBeNull()

      vi.setSystemTime(WALL_CLOCK + stepMs)
      const sendSignal = vi.fn()
      const killRoot = vi.fn()
      const teardown = killWithDescendantSweep(100, killRoot, {
        platform: 'darwin',
        sendSignal,
        timeoutMs: 1_000,
        graceMs: 60_000
      })
      finishAbandoned([row(1, 0), row(100, 1), row(200, 100)])
      await teardown

      expect(killRoot).toHaveBeenCalledOnce()
      // The fresh rows were used: their real descendant is signalled, the reused pid is not.
      expect(sendSignal.mock.calls).toEqual([[300, 'SIGTERM']])
      expect(readProcessTable).toHaveBeenCalledTimes(2)
    }
  )
})
