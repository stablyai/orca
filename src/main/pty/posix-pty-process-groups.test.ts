import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../../shared/child-process/run-process'

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
  readPosixPtyProcessTable,
  resetPosixPtyProcessTableDialectForTests
} from './posix-pty-process-groups'

beforeEach(() => {
  recordSelfInitiatedTreeKillMock.mockReset()
  runProcessMock.mockReset()
  runProcessSyncMock.mockReset()
  resetPosixPtyProcessTableDialectForTests()
})

const TABLE = `
  100  100 ttys001
  101  101 ttys001
  102  101 ttys001
  103  103 ttys001
  200  200 ttys002
  300  300 ??
`

const ALL_PROCESS_ARGS = ['-e', '-o', 'pid=PROCESS_ID,pgid=PROCESS_GID,tty=TERMINAL_DEVICE_NUMBER']
const BUSYBOX_TABLE = `
PROCESS_ID PROCESS_GID TERMINAL_DEVICE_NUMBER
100 100 136,100
101 101 136,100
200 200 136,10
201 201 136,10
999 999 ?
`
const unsupportedSelection = (stderr = 'ps: unrecognized option: p\n'): ProcessResult => ({
  code: 1,
  signal: null,
  stdout: '',
  stderr,
  timedOut: false
})

describe('ps selection compatibility', () => {
  it.each([
    ['p', 'ps: unrecognized option: p\nBusyBox v1.37\nUsage: ps'],
    ['p', "ps: invalid option -- 'p'\n"],
    ['p', 'ps: illegal option -- p\n'],
    ['t', 'ps: unrecognized option: t\n']
  ])(
    'falls back after a rejected %s selector and caches only the dialect (%s)',
    async (option, stderr) => {
      if (option === 't') {
        runProcessMock.mockResolvedValueOnce({ code: 0, stdout: '100 100 pts/100' })
      }
      runProcessMock
        .mockResolvedValueOnce(unsupportedSelection(stderr))
        .mockResolvedValueOnce({ code: 0, stdout: BUSYBOX_TABLE })
        .mockResolvedValueOnce({
          code: 0,
          stdout: BUSYBOX_TABLE.replace('201 201 136,10', '202 202 136,10')
        })

      const first = await readPosixPtyProcessTable(100)
      const second = await readPosixPtyProcessTable(200)
      expect(first).toBe(BUSYBOX_TABLE)
      expect(getPosixPtyProcessGroups(first, 100, 999)).toEqual([101, 100])
      expect(getPosixPtyProcessGroups(second, 200, 999)).toEqual([202, 200])
      expect(runProcessMock.mock.calls.map(([spec]) => spec.args)).toEqual([
        ['-p', '100', '-o', 'pid=,pgid=,tty='],
        ...(option === 't' ? [['-t', 'pts/100', '-o', 'pid=,pgid=,tty=']] : []),
        ALL_PROCESS_ARGS,
        ALL_PROCESS_ARGS
      ])
      expect(
        runProcessMock.mock.calls.every(
          ([spec]) => spec.maxOutputBytes === 1048576 && spec.timeoutMs === 1000
        )
      ).toBe(true)
    }
  )

  it('shares the initial unsupported probe across concurrent callers and cancels waiting independently', async () => {
    let resolveProbe: (result: ProcessResult) => void = () => {}
    runProcessMock
      .mockImplementationOnce(
        () =>
          new Promise<ProcessResult>((resolve) => {
            resolveProbe = resolve
          })
      )
      .mockResolvedValue({ code: 0, stdout: BUSYBOX_TABLE })
    const first = readPosixPtyProcessTable(100)
    const second = readPosixPtyProcessTable(200)
    const controller = new AbortController()
    const cancelled = readPosixPtyProcessTable(300, controller.signal)
    expect(runProcessMock).toHaveBeenCalledOnce()
    controller.abort()
    await expect(cancelled).rejects.toThrow()
    resolveProbe(unsupportedSelection())

    expect(getPosixPtyProcessGroups(await first, 100, 999)).toEqual([101, 100])
    expect(getPosixPtyProcessGroups(await second, 200, 999)).toEqual([201, 200])
    expect(runProcessMock.mock.calls.map(([spec]) => spec.args)).toEqual([
      ['-p', '100', '-o', 'pid=,pgid=,tty='],
      ALL_PROCESS_ARGS,
      ALL_PROCESS_ARGS
    ])
  })

  it('uses the cached async dialect for synchronous teardown with fresh membership', async () => {
    runProcessMock
      .mockResolvedValueOnce(unsupportedSelection())
      .mockResolvedValueOnce({ code: 0, stdout: BUSYBOX_TABLE })
    await readPosixPtyProcessTable(100)
    runProcessSyncMock.mockReturnValue({
      code: 0,
      stdout: BUSYBOX_TABLE.replace('101 101 136,100', '102 102 136,100')
    })
    const signalProcessGroup = vi.fn()
    const fallback = vi.fn()
    forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'linux',
      currentPid: 999,
      signalProcessGroup
    })
    expect(runProcessSyncMock.mock.calls.map(([spec]) => spec.args)).toEqual([ALL_PROCESS_ARGS])
    expect(signalProcessGroup.mock.calls).toEqual([[102], [100]])
    expect(fallback).not.toHaveBeenCalled()
  })

  it('discovers unsupported selection during teardown and shares it with async readers', async () => {
    runProcessSyncMock
      .mockReturnValueOnce(unsupportedSelection())
      .mockReturnValueOnce({ code: 0, stdout: BUSYBOX_TABLE })
    const signalProcessGroup = vi.fn()
    const fallback = vi.fn()
    forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'linux',
      currentPid: 999,
      signalProcessGroup
    })
    expect(signalProcessGroup.mock.calls).toEqual([[101], [100]])
    expect(fallback).not.toHaveBeenCalled()
    runProcessMock.mockResolvedValueOnce({ code: 0, stdout: BUSYBOX_TABLE })
    await readPosixPtyProcessTable(200)
    expect(runProcessMock.mock.calls.map(([spec]) => spec.args)).toEqual([ALL_PROCESS_ARGS])
  })

  it.each([
    { stderr: 'ps: permission denied' },
    { stderr: 'ps: unrecognized option: o' },
    { stderr: 'ps: unrecognized option: t' },
    { timedOut: true },
    { outputTruncated: true },
    { code: null, signal: 'SIGTERM' }
  ])('does not turn an unrelated failure into a full-host scan: %j', async (failure) => {
    runProcessMock.mockResolvedValueOnce({ ...unsupportedSelection(), ...failure })
    await expect(readPosixPtyProcessTable(100)).rejects.toThrow('unavailable')
    expect(runProcessMock).toHaveBeenCalledOnce()
    runProcessMock
      .mockResolvedValueOnce({ code: 0, stdout: '100 100 ttys001' })
      .mockResolvedValueOnce({ code: 0, stdout: TABLE })
    await readPosixPtyProcessTable(100)
    expect(runProcessMock.mock.calls[1][0].args).toEqual(['-p', '100', '-o', 'pid=,pgid=,tty='])
  })

  it.each([{ code: 1 }, { code: 0, timedOut: true }, { code: 0, outputTruncated: true }])(
    'rejects incomplete fallback snapshots for async discovery and sync teardown: %j',
    async (failure) => {
      runProcessMock
        .mockResolvedValueOnce(unsupportedSelection())
        .mockResolvedValueOnce({ stdout: BUSYBOX_TABLE, ...failure })
      await expect(readPosixPtyProcessTable(100)).rejects.toThrow('unavailable')
      runProcessSyncMock.mockReturnValue({ stdout: BUSYBOX_TABLE, ...failure })
      const signalProcessGroup = vi.fn()
      const fallback = vi.fn()
      forceKillPosixPtyProcessGroups(100, fallback, {
        platform: 'linux',
        currentPid: 999,
        signalProcessGroup
      })
      expect(fallback).toHaveBeenCalledOnce()
      expect(signalProcessGroup).not.toHaveBeenCalled()
    }
  )

  it('does not cache a rejected selector if the caller has already cancelled', async () => {
    const controller = new AbortController()
    runProcessMock.mockImplementationOnce(async () => {
      controller.abort()
      return unsupportedSelection()
    })
    await expect(readPosixPtyProcessTable(100, controller.signal)).rejects.toThrow()
    expect(runProcessMock).toHaveBeenCalledOnce()
    runProcessMock.mockResolvedValueOnce({ code: 0, stdout: '100 100 ?' })
    await readPosixPtyProcessTable(100)
    expect(runProcessMock.mock.calls[1][0].args[0]).toBe('-p')
  })

  it.each(['?', '??', '-', '0', '0,0'])(
    'refuses to group processes without a controlling terminal (%s)',
    (tty) => {
      expect(getPosixPtyProcessGroups(`100 100 ${tty}\n101 101 ${tty}`, 100, 999)).toBeNull()
    }
  )

  it('preserves full numeric terminal identity and the daemon terminal guard', () => {
    expect(getPosixPtyProcessGroups(BUSYBOX_TABLE, 100, 999)).toEqual([101, 100])
    expect(getPosixPtyProcessGroups(BUSYBOX_TABLE, 200, 999)).toEqual([201, 200])
    expect(getPosixPtyProcessGroups(BUSYBOX_TABLE, 100, 101)).toBeNull()
  })
})

describe('asynchronous PTY process discovery', () => {
  it('bounds each lookup and selects the root terminal without synchronous subprocesses', async () => {
    const controller = new AbortController()
    runProcessMock
      .mockResolvedValueOnce({ code: 0, stdout: '100 100 ttys001' })
      .mockResolvedValueOnce({ code: 0, stdout: TABLE })

    expect(await readPosixPtyProcessTable(100, controller.signal)).toBe(`100 100 ttys001\n${TABLE}`)
    expect(
      runProcessMock.mock.calls.map(([spec]) => [{ ...spec, env: { LC_ALL: spec.env.LC_ALL } }])
    ).toEqual([
      [
        {
          program: 'ps',
          env: { LC_ALL: 'C' },
          args: ['-p', '100', '-o', 'pid=,pgid=,tty='],
          timeoutMs: 1000,
          maxOutputBytes: 1048576,
          signal: controller.signal
        }
      ],
      [
        {
          program: 'ps',
          env: { LC_ALL: 'C' },
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
    await expect(readPosixPtyProcessTable(100, controller.signal)).rejects.toThrow()
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
