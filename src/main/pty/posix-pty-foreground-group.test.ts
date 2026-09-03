import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  getPosixPtyForegroundGroup,
  resetPosixPtyForegroundGroupOwnRowCache,
  signalPosixPtyForegroundGroup
} from './posix-pty-foreground-group'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => '') }))

// The concatenated output of two `ps -p <pid> -o pid=,tpgid=,tty=` calls.
const macosTable = ['84644 84985 ttys318', '  4242     4242 ttys002'].join('\n')

describe('getPosixPtyForegroundGroup', () => {
  it('returns the tty foreground group, not the root pid group', () => {
    // Why: on macOS the root is login(1) and the shell setpgid's into its own group,
    // so the root pid is never a member of the group a real resize signals.
    expect(getPosixPtyForegroundGroup(macosTable, 84644, '/dev/ttys318', 4242)).toBe(84985)
  })

  it('accepts a Linux pts device name', () => {
    expect(getPosixPtyForegroundGroup('900 931 pts/3', 900, '/dev/pts/3', 4242)).toBe(931)
  })

  it('refuses when the pid now answers for a different tty', () => {
    // Why: `ps -p` answers for whoever owns the pid now — a recycled pid must not
    // aim a group signal at a real terminal.
    expect(getPosixPtyForegroundGroup(macosTable, 84644, '/dev/ttys999', 4242)).toBeNull()
  })

  it('refuses when this process shares the PTY', () => {
    // Why: a dev daemon can inherit its launch TTY; group-signalling would hit Orca.
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
  const table = (): string => macosTable

  it('signals the negated foreground group', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const fallback = vi.fn()
    try {
      signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
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

  it('falls back to the root pid on Windows', () => {
    // Why: a negative pid is invalid there, and SIGTERM/SIGINT mean terminate.
    const fallback = vi.fn()
    signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
      platform: 'win32',
      currentPid: 4242,
      readProcessTable: table
    })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('falls back when the slave device name is unknown', () => {
    const fallback = vi.fn()
    signalPosixPtyForegroundGroup(84644, undefined, 'SIGWINCH', fallback, {
      platform: 'darwin',
      currentPid: 4242,
      readProcessTable: table
    })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('falls back when the process table cannot be read', () => {
    const fallback = vi.fn()
    signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
      platform: 'darwin',
      currentPid: 4242,
      readProcessTable: () => {
        throw new Error('ps timed out')
      }
    })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('treats a vanished foreground group as done rather than falling back', () => {
    // Why: the fallback target is just as stale, and re-signalling a recycled pid is worse.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('no such process') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })
    const fallback = vi.fn()
    try {
      signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
        platform: 'darwin',
        currentPid: 4242,
        readProcessTable: table
      })
      expect(fallback).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it('falls back when foreground group signalling fails', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })
    const fallback = vi.fn()
    try {
      signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', fallback, {
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

  it('asks ps for one pid at a time', () => {
    // Why pinned: macOS ps only takes its by-pid fast path for a SINGLE pid. Any list
    // form walks the whole process table (~3.6s on a busy machine vs ~3ms), which
    // exceeds this module's timeout and silently reinstates root-pid delivery — the
    // exact bug it exists to fix. Regressing this looks like a working feature.
    const execFileSyncMock = vi.mocked(execFileSync)
    execFileSyncMock.mockClear()
    execFileSyncMock.mockReturnValue('84644 84985 ttys318' as never)
    // Why stubbed: the resolver succeeds against the mocked table, so a live
    // process.kill would aim a real group signal at whatever owns pgid 84985 here.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    try {
      signalPosixPtyForegroundGroup(84644, '/dev/ttys318', 'SIGWINCH', vi.fn(), {
        platform: 'darwin',
        currentPid: 4242
      })

      expect(execFileSyncMock).toHaveBeenCalled()
      let timeoutBudget = 0
      for (const call of execFileSyncMock.mock.calls) {
        const args = call[1] as string[]
        const options = call[2] as { timeout: number }
        const pidArg = args[args.indexOf('-p') + 1]
        expect(pidArg).toMatch(/^\d+$/)
        expect(args.filter((arg) => arg === '-p')).toHaveLength(1)
        timeoutBudget += options.timeout
      }
      expect(timeoutBudget).toBeLessThanOrEqual(250)
    } finally {
      kill.mockRestore()
    }
  })

  it('forks ps once per pane after the first SIGWINCH of the process', () => {
    // Why: `runPs(currentPid)` reads Orca's own controlling tty, which cannot change
    // for the process lifetime and feeds only the "do we share this PTY" guard. The
    // renderer fires SIGWINCH twice per revealed pane, so re-forking it made a 4-pane
    // tab switch eight synchronous ~3ms `ps` calls on the main event loop.
    const execFileSyncMock = vi.mocked(execFileSync)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const panes = [
      { rootPid: 900, tty: 'ttys301' },
      { rootPid: 901, tty: 'ttys302' },
      { rootPid: 902, tty: 'ttys303' },
      { rootPid: 903, tty: 'ttys304' }
    ]

    try {
      execFileSyncMock.mockClear()
      execFileSyncMock.mockImplementation(((_file: string, args: string[]) => {
        const pid = Number(args[args.indexOf('-p') + 1])
        if (pid === 4242) {
          return '4242 4242 ttys002'
        }
        const pane = panes.find((entry) => entry.rootPid === pid)
        return pane ? `${pane.rootPid} ${pane.rootPid + 50} ${pane.tty}` : ''
      }) as never)

      for (const pane of panes) {
        // Two signals per revealed pane: hidden-restore snapshot + reattach repaint.
        for (let signalIndex = 0; signalIndex < 2; signalIndex += 1) {
          signalPosixPtyForegroundGroup(pane.rootPid, `/dev/${pane.tty}`, 'SIGWINCH', vi.fn(), {
            platform: 'darwin',
            currentPid: 4242
          })
        }
      }

      const pidArgs = execFileSyncMock.mock.calls.map((call) =>
        Number((call[1] as string[])[(call[1] as string[]).indexOf('-p') + 1])
      )
      // 8 root-pid reads (one per signal) + exactly ONE read of Orca's own row.
      expect(pidArgs.filter((pid) => pid === 4242)).toHaveLength(1)
      expect(pidArgs).toHaveLength(9)
      expect(kill).toHaveBeenCalledTimes(8)
    } finally {
      execFileSyncMock.mockReset()
      execFileSyncMock.mockReturnValue('' as never)
      kill.mockRestore()
    }
  })
})
