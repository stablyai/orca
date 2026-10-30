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
vi.mock('node:child_process', () => ({ execFile }))

import { setLibprocAddonForTests } from '../../shared/libproc-addon'
import { resetNativeReadsForTests } from '../../shared/libproc-native-reads'
import { collectDescendantRows, parseProcessTable } from '../pty-descendant-termination'
import { terminateShutdownDescendants } from './terminal-descendant-shutdown'

const STARTED = 'Mon Jul 13 12:54:47 2026'
const PS_OUTPUT = `  100     1   100     0 ${STARTED}\n  200   100   100     0 ${STARTED}\n`

beforeEach(() => {
  vi.useFakeTimers()
  resetNativeReadsForTests()
  // A stalled libuv pool: native reads never finish.
  setLibprocAddonForTests({
    readProcessTable: () => new Promise<never>(() => {}),
    readProcessCwd: async () => null,
    readProcessPath: async () => null
  })
  // A 200ms ps, killed at its timeout like execFile.
  execFile.mockImplementation((_file, _args, { timeout }, callback) => {
    const done = setTimeout(() => {
      clearTimeout(killed)
      callback(null, PS_OUTPUT)
    }, 200)
    const killed = setTimeout(() => {
      clearTimeout(done)
      callback(new Error('ps timed out'))
    }, timeout)
  })
})
afterEach(() => {
  execFile.mockReset()
  setLibprocAddonForTests(undefined)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('terminal shutdown descendant sweep over a stalled native reader', () => {
  it('still terminates then kills a surviving descendant through a 200ms ps', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const snapshot = collectDescendantRows(100, parseProcessTable(PS_OUTPUT), Date.now())

    const verdict = terminateShutdownDescendants(snapshot)
    await vi.advanceTimersByTimeAsync(4_000)
    await verdict

    const signals = kill.mock.calls.filter(([pid]) => pid === 200).map(([, signal]) => signal)
    expect(signals[0]).toBe('SIGTERM')
    expect(signals).toContain('SIGKILL')
  })
})
