import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'

import type { ProcessResult } from '@orca/process-host/process-spec'

const {
  readFileMock,
  readFileSyncMock,
  recordSelfInitiatedTreeKillMock,
  runProcessMock,
  runProcessSyncMock
} = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  recordSelfInitiatedTreeKillMock: vi.fn(),
  runProcessMock: vi.fn(),
  runProcessSyncMock: vi.fn()
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  readFileSync: readFileSyncMock
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  readFile: readFileMock
}))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: recordSelfInitiatedTreeKillMock
}))
vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))

import {
  forceKillPosixPtyProcessGroups,
  forceKillPosixPtyProcessGroupsSync,
  getPosixPtyProcessGroups,
  isPosixPtyRootStopped,
  signalPosixPtyProcessGroups
} from './posix-pty-process-groups'
import {
  parseLinuxProcStatSessionId,
  readPosixPtyProcessTable,
  resetPosixPtyProcessTableDialectForTests
} from './posix-pty-process-table'

// `/proc/<pid>/stat` fixture: fields after comm are state, ppid, pgrp, session, tty_nr, ...
const procStat = (pid: number, session: number, comm = 'bash'): string =>
  `${pid} (${comm}) S 1 ${pid} ${session} 34822 ${pid} 4194560 1 0 0 0 0 0 0 0 20 0 1 0 98765 0 0\n`
const procSessions = new Map<number, number>()

beforeEach(() => {
  procSessions.clear()
  readFileSyncMock.mockReset()
  readFileMock.mockReset()
  // Default fixture: each hundred-block of pids is one terminal session led by its round pid.
  readFileSyncMock.mockImplementation((path: string) => {
    const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(path)?.[1])
    if (!pid) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return procStat(pid, procSessions.get(pid) ?? Math.floor(pid / 100) * 100)
  })
  readFileMock.mockImplementation(async (path: string) => readFileSyncMock(path))
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

const ALL_PROCESS_ARGS = [
  '-e',
  '-o',
  'pid=PROCESS_ID,pgid=PROCESS_GID,tty=TERMINAL_DEVICE_NUMBER,stat=PROCESS_STATE'
]
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
        ['-p', '100', '-o', 'pid=,pgid=,tty=,stat='],
        ...(option === 't' ? [['-t', 'pts/100', '-o', 'pid=,pgid=,tty=,stat=']] : []),
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
      ['-p', '100', '-o', 'pid=,pgid=,tty=,stat='],
      ALL_PROCESS_ARGS,
      ALL_PROCESS_ARGS
    ])
  })

  it('releases every waiter after a failed probe instead of chaining another probe per caller', async () => {
    // A wedged ps would otherwise stack one timeout per concurrent force-kill.
    const probe = Promise.withResolvers<ProcessResult>()
    const queries: ((result: ProcessResult) => void)[] = []
    runProcessMock
      .mockImplementationOnce(() => probe.promise)
      .mockImplementation(() => new Promise((resolve) => queries.push(resolve)))
    const first = readPosixPtyProcessTable(100)
    const second = readPosixPtyProcessTable(200)
    const third = readPosixPtyProcessTable(300)

    probe.resolve({ code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true })
    await expect(first).rejects.toThrow('unavailable')
    await vi.waitFor(() => expect(runProcessMock).toHaveBeenCalledTimes(3))

    for (const resolve of queries) {
      resolve({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    }
    await expect(Promise.all([second, third])).resolves.toEqual(['', ''])
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
    forceKillPosixPtyProcessGroupsSync(100, fallback, {
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
    forceKillPosixPtyProcessGroupsSync(100, fallback, {
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
    expect(runProcessMock.mock.calls[1][0].args).toEqual([
      '-p',
      '100',
      '-o',
      'pid=,pgid=,tty=,stat='
    ])
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
      forceKillPosixPtyProcessGroupsSync(100, fallback, {
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
  it('requires a stopped state for the exact shell process', () => {
    expect(isPosixPtyRootStopped('100 100 pts/test Ts\n101 101 pts/test R+', 100)).toBe(true)
    expect(isPosixPtyRootStopped('100 100 pts/test S\n101 101 pts/test T', 100)).toBe(false)
    expect(isPosixPtyRootStopped('101 101 pts/test T', 100)).toBe(false)
    expect(isPosixPtyRootStopped('100 100 pts/test\n101 101 pts/test T', 100)).toBe(false)
  })

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
          args: ['-p', '100', '-o', 'pid=,pgid=,tty=,stat='],
          timeoutMs: 1000,
          maxOutputBytes: 1048576,
          signal: controller.signal
        }
      ],
      [
        {
          program: 'ps',
          env: { LC_ALL: 'C' },
          args: ['-t', 'ttys001', '-o', 'pid=,pgid=,tty=,stat='],
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

  it('kills foreground and background groups before the PTY leader', async () => {
    const fallback = vi.fn()
    const signalProcessGroup = vi.fn()

    await forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'darwin',
      currentPid: 999,
      readProcessTable: async () => TABLE,
      signalProcessGroup
    })

    expect(signalProcessGroup.mock.calls.map(([pgid]) => pgid)).toEqual([101, 103, 100])
    expect(fallback).not.toHaveBeenCalled()
  })

  it.each([
    ['SIGSTOP', [99, 101, 103]],
    ['SIGCONT', [101, 103, 99]]
  ] as const)('orders shell and job groups safely for %s', async (signal, expected) => {
    const signalProcessGroup = vi.fn()
    await signalPosixPtyProcessGroups(100, signal, vi.fn(), {
      platform: 'linux',
      currentPid: 999,
      readProcessTable: async () => TABLE.replace('100  100', '100  99'),
      signalProcessGroup
    })
    expect(signalProcessGroup.mock.calls.map(([pgid]) => pgid)).toEqual(expected)
  })

  it.each(['EPERM', 'ESRCH'])(
    'does not stop jobs when stopping the shell fails with %s',
    async (code) => {
      const error = Object.assign(new Error('stop failed'), { code })
      const signalProcessGroup = vi.fn(() => {
        throw error
      })
      const stop = signalPosixPtyProcessGroups(100, 'SIGSTOP', vi.fn(), {
        platform: 'linux',
        currentPid: 999,
        readProcessTable: async () => TABLE,
        signalProcessGroup
      })
      await (code === 'ESRCH'
        ? expect(stop).resolves.toBeUndefined()
        : expect(stop).rejects.toThrow(error))
      expect(signalProcessGroup.mock.calls).toEqual([[100]])
    }
  )

  it('falls back when the process table cannot prove PTY ownership', async () => {
    const fallback = vi.fn()

    await forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'linux',
      currentPid: 102,
      readProcessTable: async () => TABLE,
      signalProcessGroup: vi.fn()
    })

    expect(fallback).toHaveBeenCalledOnce()
  })

  it('ignores groups that exited after the snapshot but preserves real signal errors', async () => {
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

    await expect(
      forceKillPosixPtyProcessGroups(100, vi.fn(), {
        platform: 'darwin',
        currentPid: 999,
        readProcessTable: async () => TABLE,
        signalProcessGroup
      })
    ).rejects.toThrow('denied')
    expect(signalProcessGroup).toHaveBeenCalledTimes(3)
  })

  it('signals nothing when the root exits while the table is read', async () => {
    // A reaped root frees its pid and TTY, so the table may now describe another terminal.
    let rootExited = false
    const fallback = vi.fn()
    const signalProcessGroup = vi.fn()

    await forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'darwin',
      currentPid: 999,
      readProcessTable: async () => {
        rootExited = true
        return TABLE
      },
      ownsRoot: () => !rootExited,
      signalProcessGroup
    })

    expect(signalProcessGroup).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('uses the existing fallback on Windows without reading ps', async () => {
    const fallback = vi.fn()
    const readProcessTable = vi.fn(async () => TABLE)

    await forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'win32',
      readProcessTable
    })

    expect(fallback).toHaveBeenCalledOnce()
    expect(readProcessTable).not.toHaveBeenCalled()
  })
})

describe('Linux terminal session identity (#27337)', () => {
  // Container devpts instances reuse pts numbers: tty alone cannot tell host pts/6 from a container's.
  const COLLIDING_TABLE = `
100 100 pts/6 Ss
101 101 pts/6 S+
500 500 pts/6 Ss
501 500 pts/6 S
600 600 pts/6 Ss
`

  it('parses the session id past a comm containing spaces and parentheses', () => {
    expect(parseLinuxProcStatSessionId(procStat(42, 7, 'evil) S 1 2 3 (x'))).toBe(7)
    expect(parseLinuxProcStatSessionId('42 (bash')).toBeNull()
    expect(parseLinuxProcStatSessionId('42 (bash) S 1 42')).toBeNull()
    expect(parseLinuxProcStatSessionId('42 (bash) S 1 42 0 0')).toBeNull()
  })

  it('force-kills only groups in the shell session, not container processes on the same pts', async () => {
    procSessions.set(500, 500).set(501, 500).set(600, 600)
    const signalProcessGroup = vi.fn()
    const fallback = vi.fn()
    await forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'linux',
      currentPid: 999,
      readProcessTable: async () => COLLIDING_TABLE,
      signalProcessGroup
    })
    expect(signalProcessGroup.mock.calls).toEqual([[101], [100]])
    expect(fallback).not.toHaveBeenCalled()
    expect(readFileMock).toHaveBeenCalledWith('/proc/500/stat', 'utf8')
  })

  it('applies the same session filter to the stop/continue sweep', async () => {
    procSessions.set(500, 500).set(501, 500).set(600, 600)
    const signalProcessGroup = vi.fn()
    await signalPosixPtyProcessGroups(100, 'SIGSTOP', vi.fn(), {
      platform: 'linux',
      currentPid: 999,
      readProcessTable: async () => COLLIDING_TABLE,
      signalProcessGroup
    })
    expect(signalProcessGroup.mock.calls).toEqual([[100], [101]])
  })

  it('excludes candidates whose session can no longer be read', () => {
    expect(
      getPosixPtyProcessGroups(COLLIDING_TABLE, 100, 999, (pid) =>
        pid === 101 ? null : pid < 200 ? 100 : pid
      )
    ).toEqual([100])
  })

  it.each([
    ['unreadable', async () => null],
    ['not a session leader', async () => 50]
  ])('falls back to the root-only kill when the shell session is %s', async (_label, sessionOf) => {
    const signalProcessGroup = vi.fn()
    const fallback = vi.fn()
    await forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'linux',
      currentPid: 999,
      readProcessTable: async () => COLLIDING_TABLE,
      readProcessSessionId: sessionOf,
      signalProcessGroup
    })
    expect(fallback).toHaveBeenCalledOnce()
    expect(signalProcessGroup).not.toHaveBeenCalled()
  })

  it('keeps macOS selection by terminal alone without reading /proc', async () => {
    const signalProcessGroup = vi.fn()
    await forceKillPosixPtyProcessGroups(100, vi.fn(), {
      platform: 'darwin',
      currentPid: 999,
      readProcessTable: async () => COLLIDING_TABLE,
      signalProcessGroup
    })
    expect(signalProcessGroup.mock.calls).toEqual([[101], [500], [600], [100]])
    expect(readFileMock).not.toHaveBeenCalled()
  })
})

describe('POSIX PTY group-sweep breadcrumbs', () => {
  it('records every group it actually signalled', async () => {
    await forceKillPosixPtyProcessGroups(100, vi.fn(), {
      platform: 'darwin',
      currentPid: 999,
      readProcessTable: async () => TABLE,
      signalProcessGroup: vi.fn()
    })

    expect(recordSelfInitiatedTreeKillMock.mock.calls.map(([kill]) => kill)).toEqual([
      { pid: 101, site: 'posix-pty-process-group-sweep', scope: 'posix-process-group' },
      { pid: 103, site: 'posix-pty-process-group-sweep', scope: 'posix-process-group' },
      { pid: 100, site: 'posix-pty-process-group-sweep', scope: 'posix-process-group' }
    ])
  })

  it('does not claim a group that was already gone', async () => {
    await forceKillPosixPtyProcessGroups(100, vi.fn(), {
      platform: 'darwin',
      currentPid: 999,
      readProcessTable: async () => TABLE,
      signalProcessGroup: (pgid: number) => {
        if (pgid === 103) {
          throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
        }
      }
    })

    expect(recordSelfInitiatedTreeKillMock.mock.calls.map(([kill]) => kill.pid)).toEqual([101, 100])
  })
})
