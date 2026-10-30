import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import {
  getPosixPtyForegroundGroup,
  resetPosixPtyForegroundGroupOwnRowCache,
  signalPosixPtyForegroundGroup
} from './posix-pty-foreground-group'

const { runProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>()
}))
const pidArg = (spec: ProcessSpec): string => {
  const args = spec.args ?? []
  return args[args.indexOf('-p') + 1]
}
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

const psResult = (stdout: string): ProcessResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})

const macosTable = ['84644 84985 ttys318', '  4242     4242 ttys002'].join('\n')

describe('getPosixPtyForegroundGroup', () => {
  it('returns the tty foreground group, not the root pid group', () => {
    // macOS login(1) is the root; the shell moves into the group that actually receives resize signals.
    expect(getPosixPtyForegroundGroup(macosTable, 84644, '/dev/ttys318', 4242)).toBe(84985)
  })

  it('accepts a Linux pts device name', () => {
    expect(getPosixPtyForegroundGroup('900 931 pts/3', 900, '/dev/pts/3', 4242)).toBe(931)
  })

  it('refuses when the pid now answers for a different tty', () => {
    // A recycled root PID must not signal another terminal's group.
    expect(getPosixPtyForegroundGroup(macosTable, 84644, '/dev/ttys999', 4242)).toBeNull()
  })

  it('refuses when this process shares the PTY', () => {
    // A dev daemon can inherit its launch TTY; group signals must not reach Orca.
    const shared = ['84644 84985 ttys318', '4242 84985 ttys318'].join('\n')
    expect(getPosixPtyForegroundGroup(shared, 84644, '/dev/ttys318', 4242)).toBeNull()
  })

  it('refuses a detached tty or an unowned foreground group', () => {
    expect(getPosixPtyForegroundGroup('84644 84985 ??', 84644, '/dev/ttys318', 4242)).toBeNull()
    expect(getPosixPtyForegroundGroup('84644 -1 ttys318', 84644, '/dev/ttys318', 4242)).toBeNull()
    expect(getPosixPtyForegroundGroup('84644 1 ttys318', 84644, '/dev/ttys318', 4242)).toBeNull()
  })

  it('refuses when the root pid is absent from the table', () => {
    expect(getPosixPtyForegroundGroup('4242 4242 ttys002', 84644, '/dev/ttys318', 4242)).toBeNull()
  })
})

describe('signalPosixPtyForegroundGroup', () => {
  const table = async (): Promise<string> => macosTable

  it('signals the negated foreground group', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const fallback = vi.fn()
    try {
      await signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
        platform: 'darwin',
        currentPid: 4242,
        readProcessTable: table
      })
      expect(kill).toHaveBeenCalledWith(-84985, 'SIGWINCH')
      expect(fallback).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it('falls back to the root pid on Windows', async () => {
    // Windows rejects negative PIDs and treats SIGTERM/SIGINT as termination.
    const fallback = vi.fn()
    await signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
      platform: 'win32',
      currentPid: 4242,
      readProcessTable: table
    })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('falls back when the slave device name is unknown', async () => {
    const fallback = vi.fn()
    await signalPosixPtyForegroundGroup(84644, undefined, 'SIGWINCH', fallback, {
      platform: 'darwin',
      currentPid: 4242,
      readProcessTable: table
    })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('falls back when the process table cannot be read', async () => {
    const fallback = vi.fn()
    await signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
      platform: 'darwin',
      currentPid: 4242,
      readProcessTable: async () => {
        throw new Error('ps timed out')
      }
    })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('treats a vanished foreground group as done rather than falling back', async () => {
    // ESRCH means the captured target vanished; root fallback would be stale too.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('no such process') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })
    const fallback = vi.fn()
    try {
      await signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
        platform: 'darwin',
        currentPid: 4242,
        readProcessTable: table
      })
      expect(fallback).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it('falls back when foreground group signalling fails', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })
    const fallback = vi.fn()
    try {
      await signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
        platform: 'darwin',
        currentPid: 4242,
        readProcessTable: table
      })
      expect(fallback).toHaveBeenCalledOnce()
    } finally {
      kill.mockRestore()
    }
  })
})

describe('process table lookup', () => {
  beforeEach(() => {
    resetPosixPtyForegroundGroupOwnRowCache()
  })

  it('asks ps for one pid at a time', async () => {
    // macOS PID lists scan the whole table (~3.6s vs ~3ms), silently timing out into root-only delivery.
    runProcessMock.mockReset()
    runProcessMock.mockResolvedValue(psResult('84644 84985 ttys318'))
    // Mock group signalling so fixture PGIDs cannot target real host processes.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      await signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', vi.fn(), {
        platform: 'darwin',
        currentPid: 4242
      })

      expect(runProcessMock).toHaveBeenCalled()
      let timeoutBudget = 0
      for (const [spec] of runProcessMock.mock.calls) {
        expect(pidArg(spec)).toMatch(/^\d+$/)
        expect(spec.args?.filter((arg) => arg === '-p')).toHaveLength(1)
        timeoutBudget += spec.timeoutMs ?? Infinity
      }
      expect(timeoutBudget).toBeLessThanOrEqual(250)
    } finally {
      kill.mockRestore()
    }
  })

  it('forks ps once per pane after the first SIGWINCH of the process', async () => {
    // Reuse Orca's own TTY row: repeated ps forks doubled the per-pane resize cost.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const panes = [
      { rootPid: 900, tty: 'ttys301' },
      { rootPid: 901, tty: 'ttys302' },
      { rootPid: 902, tty: 'ttys303' },
      { rootPid: 903, tty: 'ttys304' }
    ]

    try {
      runProcessMock.mockReset()
      runProcessMock.mockImplementation(async (spec) => {
        const pid = Number(pidArg(spec))
        if (pid === 4242) {
          return psResult('4242 4242 ttys002')
        }
        const pane = panes.find((entry) => entry.rootPid === pid)
        return psResult(pane ? `${pane.rootPid} ${pane.rootPid + 50} ${pane.tty}` : '')
      })

      for (const pane of panes) {
        // Hidden restore and reattach each signal once per pane.
        for (let signalIndex = 0; signalIndex < 2; signalIndex += 1) {
          await signalPosixPtyForegroundGroup(
            pane.rootPid,
            `/dev/${pane.tty}`,
            'SIGWINCH',
            vi.fn(),
            {
              platform: 'darwin',
              currentPid: 4242
            }
          )
        }
      }

      const pidArgs = runProcessMock.mock.calls.map(([spec]) => Number(pidArg(spec)))
      expect(pidArgs.filter((pid) => pid === 4242)).toHaveLength(1)
      expect(pidArgs).toHaveLength(9)
      expect(kill).toHaveBeenCalledTimes(8)
    } finally {
      runProcessMock.mockReset()
      kill.mockRestore()
    }
  })
})
