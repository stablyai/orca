import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))

import {
  claimDarwinTerminalNaming,
  resetDarwinTerminalNamingForTests
} from '../../shared/darwin-terminal-naming-single-flight'
import { setLibprocAddonForTests, type LibprocProcessRow } from '../../shared/libproc-addon'
import { resetNativeReadsForTests } from '../../shared/libproc-native-reads'
import {
  resetPosixPtyForegroundGroupOwnRowCache,
  signalPosixPtyForegroundGroup
} from './posix-pty-foreground-group'

const ROOT_PID = 4200
const CURRENT_PID = 900
const FOREGROUND_PGID = 4300

function row(pid: number): LibprocProcessRow {
  return {
    pid,
    ppid: 1,
    pgid: pid,
    tpgid: FOREGROUND_PGID,
    tdev: (16 << 24) | 4,
    status: 3,
    flags: 0x2,
    sessionLeader: false,
    startSec: 0,
    comm: 'zsh'
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetDarwinTerminalNamingForTests()
  resetNativeReadsForTests()
  resetPosixPtyForegroundGroupOwnRowCache()
})
afterEach(() => {
  setLibprocAddonForTests(undefined)
  runProcess.mockReset()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('foreground group signalling over the in-process reader', () => {
  it('gives an 80ms ps its whole timeout while a terminal naming pass is held', async () => {
    setLibprocAddonForTests({
      readProcessTable: async () => [row(ROOT_PID)],
      processCwd: () => null,
      processPath: () => null
    })
    claimDarwinTerminalNaming(() => new Promise<never>(() => {}))
    // An 80ms ps, killed at its timeout like process-host's runProcess.
    runProcess.mockImplementation(
      ({ args, timeoutMs }: { args: string[]; timeoutMs: number }) =>
        new Promise((resolve) => {
          const pid = Number(args[1])
          const stdout =
            pid === ROOT_PID ? `${ROOT_PID} ${FOREGROUND_PGID} ttys004\n` : `${pid} 0 ??\n`
          const done = setTimeout(() => {
            clearTimeout(killed)
            resolve({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
          }, 80)
          const killed = setTimeout(() => {
            clearTimeout(done)
            resolve({ code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true })
          }, timeoutMs)
        })
    )
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const fallback = vi.fn()

    const signalled = signalPosixPtyForegroundGroup(
      ROOT_PID,
      '/dev/ttys004',
      'SIGWINCH',
      fallback,
      { platform: 'darwin', currentPid: CURRENT_PID }
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await signalled

    expect(fallback).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith(-FOREGROUND_PGID, 'SIGWINCH')
  })
})
