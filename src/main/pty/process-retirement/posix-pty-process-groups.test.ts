import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'

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
vi.mock('../../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: recordSelfInitiatedTreeKillMock
}))
vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))
import {
  forceKillPosixPtyProcessGroups,
  getPosixPtyProcessGroups,
  signalPosixPtyProcessGroups
} from './posix-pty-process-groups'
import { resetPosixPtyProcessTableDialectForTests } from './posix-pty-process-table'

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
const BUSYBOX_TABLE = `
PROCESS_ID PROCESS_GID TERMINAL_DEVICE_NUMBER
100 100 136,100
101 101 136,100
200 200 136,10
201 201 136,10
999 999 ?
`

describe('ps selection compatibility', () => {
  it('preserves full numeric terminal identity and the daemon terminal guard', () => {
    expect(getPosixPtyProcessGroups(BUSYBOX_TABLE, 100, 999)).toEqual([101, 100])
    expect(getPosixPtyProcessGroups(BUSYBOX_TABLE, 200, 999)).toEqual([201, 200])
    expect(getPosixPtyProcessGroups(BUSYBOX_TABLE, 100, 101)).toBeNull()
  })
})

describe('POSIX PTY process-group termination', () => {
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
})
