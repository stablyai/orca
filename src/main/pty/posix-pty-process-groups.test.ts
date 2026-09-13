import { beforeEach, describe, expect, it, vi } from 'vitest'

const { recordSelfInitiatedTreeKillMock, runProcessSyncMock } = vi.hoisted(() => ({
  recordSelfInitiatedTreeKillMock: vi.fn(),
  runProcessSyncMock: vi.fn()
}))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: recordSelfInitiatedTreeKillMock
}))
vi.mock('../../shared/child-process/run-process', () => ({
  runProcessSync: runProcessSyncMock
}))

import {
  forceKillPosixPtyProcessGroups,
  getPosixPtyProcessGroups
} from './posix-pty-process-groups'

beforeEach(() => {
  recordSelfInitiatedTreeKillMock.mockReset()
  runProcessSyncMock.mockReset()
})

const TABLE = `
  100  100 ttys001
  101  101 ttys001
  102  101 ttys001
  103  103 ttys001
  200  200 ttys002
  300  300 ??
`

describe('POSIX PTY process-group termination', () => {
  it('returns every group attached to the root PTY with the root group last', () => {
    expect(getPosixPtyProcessGroups(TABLE, 100, 999)).toEqual([101, 103, 100])
  })

  it('refuses an unbound root or a PTY shared with Orca itself', () => {
    expect(getPosixPtyProcessGroups(TABLE, 300, 999)).toBeNull()
    expect(getPosixPtyProcessGroups(TABLE, 100, 102)).toBeNull()
    expect(getPosixPtyProcessGroups(TABLE, 999, 998)).toBeNull()
  })

  it('kills foreground and background groups before the PTY leader', () => {
    const fallback = vi.fn()
    const signalProcessGroup = vi.fn()

    forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'darwin',
      currentPid: 999,
      readProcessTable: () => TABLE,
      signalProcessGroup
    })

    expect(signalProcessGroup.mock.calls.map(([pgid]) => pgid)).toEqual([101, 103, 100])
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back when the process table cannot prove PTY ownership', () => {
    const fallback = vi.fn()

    forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'linux',
      currentPid: 102,
      readProcessTable: () => TABLE,
      signalProcessGroup: vi.fn()
    })

    expect(fallback).toHaveBeenCalledOnce()
  })

  it('ignores groups that exited after the snapshot but preserves real signal errors', () => {
    const gone = Object.assign(new Error('gone'), { code: 'ESRCH' })
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' })
    const signalProcessGroup = vi
      .fn<(pgid: number) => void>()
      .mockImplementationOnce(() => {
        throw gone
      })
      .mockImplementationOnce(() => {
        throw denied
      })

    expect(() =>
      forceKillPosixPtyProcessGroups(100, vi.fn(), {
        platform: 'darwin',
        currentPid: 999,
        readProcessTable: () => TABLE,
        signalProcessGroup
      })
    ).toThrow('denied')
    expect(signalProcessGroup).toHaveBeenCalledTimes(3)
  })

  it('uses the existing fallback on Windows without reading ps', () => {
    const fallback = vi.fn()
    const readProcessTable = vi.fn(() => TABLE)

    forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'win32',
      readProcessTable
    })

    expect(fallback).toHaveBeenCalledOnce()
    expect(readProcessTable).not.toHaveBeenCalled()
  })
})

describe('POSIX PTY group-sweep breadcrumbs', () => {
  it('records every group it actually signalled', () => {
    forceKillPosixPtyProcessGroups(100, vi.fn(), {
      platform: 'darwin',
      currentPid: 999,
      readProcessTable: () => TABLE,
      signalProcessGroup: vi.fn()
    })

    expect(recordSelfInitiatedTreeKillMock.mock.calls.map(([kill]) => kill)).toEqual([
      { pid: 101, site: 'posix-pty-process-group-sweep', scope: 'posix-process-group' },
      { pid: 103, site: 'posix-pty-process-group-sweep', scope: 'posix-process-group' },
      { pid: 100, site: 'posix-pty-process-group-sweep', scope: 'posix-process-group' }
    ])
  })

  it('does not claim a group that was already gone', () => {
    forceKillPosixPtyProcessGroups(100, vi.fn(), {
      platform: 'darwin',
      currentPid: 999,
      readProcessTable: () => TABLE,
      signalProcessGroup: (pgid: number) => {
        if (pgid === 103) {
          throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
        }
      }
    })

    expect(recordSelfInitiatedTreeKillMock.mock.calls.map(([kill]) => kill.pid)).toEqual([101, 100])
  })
})

describe('POSIX PTY process table read', () => {
  it('reads the table through the sanctioned runner, tty-scoped', () => {
    runProcessSyncMock.mockImplementation((spec: { args: string[] }) =>
      spec.args.includes('-t')
        ? { code: 0, signal: null, stdout: TABLE, stderr: '', timedOut: false }
        : { code: 0, signal: null, stdout: '  100  100 ttys001', stderr: '', timedOut: false }
    )

    forceKillPosixPtyProcessGroups(100, vi.fn(), {
      platform: 'darwin',
      currentPid: 999,
      signalProcessGroup: vi.fn()
    })

    const specs = runProcessSyncMock.mock.calls.map(([spec]) => spec)
    expect(specs.every((spec) => spec.program === 'ps')).toBe(true)
    // Why pinned: a whole-host `ps -ax` retains the cost this module exists to bound.
    expect(specs.some((spec) => spec.args.includes('-ax'))).toBe(false)
    expect(specs.at(-1).args).toContain('-t')
  })

  it('falls back when the runner reports a non-zero ps', () => {
    runProcessSyncMock.mockReturnValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    const fallback = vi.fn()

    forceKillPosixPtyProcessGroups(100, fallback, { platform: 'darwin', currentPid: 999 })

    expect(fallback).toHaveBeenCalledTimes(1)
  })
})
