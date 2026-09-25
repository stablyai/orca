import { beforeEach, describe, expect, it, vi } from 'vitest'

const { recordSelfInitiatedTreeKillMock, runProcessMock, runProcessSyncMock } = vi.hoisted(() => ({
  recordSelfInitiatedTreeKillMock: vi.fn(),
  runProcessMock: vi.fn(),
  runProcessSyncMock: vi.fn()
}))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: recordSelfInitiatedTreeKillMock
}))
vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))

import {
  forceKillPosixPtyProcessGroups,
  getPosixPtyProcessGroups,
  readPosixPtyProcessTable
} from './posix-pty-process-groups'

beforeEach(() => {
  recordSelfInitiatedTreeKillMock.mockReset()
  runProcessMock.mockReset()
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

describe('asynchronous PTY process discovery', () => {
  it('bounds each lookup and selects the root terminal without synchronous subprocesses', async () => {
    const controller = new AbortController()
    runProcessMock
      .mockResolvedValueOnce({ code: 0, stdout: '100 100 ttys001' })
      .mockResolvedValueOnce({ code: 0, stdout: TABLE })

    expect(await readPosixPtyProcessTable(100, controller.signal)).toBe(`100 100 ttys001\n${TABLE}`)
    expect(runProcessMock.mock.calls).toEqual([
      [
        {
          program: 'ps',
          args: ['-p', '100', '-o', 'pid=,pgid=,tty='],
          timeoutMs: 1000,
          maxOutputBytes: 1048576,
          signal: controller.signal
        }
      ],
      [
        {
          program: 'ps',
          args: ['-t', 'ttys001', '-o', 'pid=,pgid=,tty='],
          timeoutMs: 1000,
          maxOutputBytes: 1048576,
          signal: controller.signal
        }
      ]
    ])
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })

  it.each([{ code: 1 }, { code: 0, timedOut: true }, { code: 0, outputTruncated: true }])(
    'rejects incomplete process evidence: %j',
    async (result) => {
      runProcessMock.mockResolvedValue({ stdout: TABLE, ...result })
      await expect(readPosixPtyProcessTable(100)).rejects.toThrow('unavailable')
      expect(runProcessMock).toHaveBeenCalledOnce()
    }
  )

  it('does not start the second lookup after cancellation', async () => {
    const controller = new AbortController()
    runProcessMock.mockImplementation(async () => {
      controller.abort()
      return { code: 0, stdout: '100 100 ttys001' }
    })
    await readPosixPtyProcessTable(100, controller.signal)
    expect(runProcessMock).toHaveBeenCalledOnce()
  })
})

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
