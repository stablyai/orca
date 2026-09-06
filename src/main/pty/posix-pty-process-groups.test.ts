import { beforeEach, describe, expect, it, vi } from 'vitest'

const { recordSelfInitiatedTreeKillMock } = vi.hoisted(() => ({
  recordSelfInitiatedTreeKillMock: vi.fn()
}))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: recordSelfInitiatedTreeKillMock
}))

import {
  forceKillPosixPtyProcessGroups,
  getPosixPtyProcessGroups
} from './posix-pty-process-groups'

beforeEach(() => {
  recordSelfInitiatedTreeKillMock.mockReset()
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

  // Measured 2026-09-02 on a loaded Mac (17 agent sessions, a test gate running): the TTY-scoped
  // `ps` timed out, so the only kill that reached the pane was the leader-only fallback. The
  // `login` leader died, its `zsh -l` and the agent underneath survived with no controlling TTY,
  // and each survivor kept an orchestration long-poll open until the runtime's 16-slot cap was
  // full. The descendant tree needs no TTY to prove ownership: everything under the leader is the
  // pane's, so it is the strategy that runs when the TTY read cannot.
  describe('descendant-tree strategy', () => {
    const TREE = `
      100    1  100
      101  100  101
      102  101  102
      103  102  103
      104  101  101
      200    1  200
      999    1  999
    `

    it('kills every group under the leader when the TTY read fails, leader group last', () => {
      const fallback = vi.fn()
      const signalProcessGroup = vi.fn()

      forceKillPosixPtyProcessGroups(100, fallback, {
        platform: 'darwin',
        currentPid: 999,
        readProcessTable: () => {
          throw new Error('ps timed out')
        },
        readDescendantTable: () => TREE,
        signalProcessGroup
      })

      expect(signalProcessGroup.mock.calls.map(([pgid]) => pgid)).toEqual([101, 102, 103, 100])
      expect(fallback).not.toHaveBeenCalled()
    })

    it('never group-signals a tree that contains Orca itself', () => {
      const fallback = vi.fn()
      const signalProcessGroup = vi.fn()

      forceKillPosixPtyProcessGroups(100, fallback, {
        platform: 'darwin',
        currentPid: 103,
        readProcessTable: () => {
          throw new Error('ps timed out')
        },
        readDescendantTable: () => TREE,
        signalProcessGroup
      })

      expect(signalProcessGroup).not.toHaveBeenCalled()
      expect(fallback).toHaveBeenCalledOnce()
    })

    it('falls back only when neither table proves what the leader owns', () => {
      const fallback = vi.fn()
      const signalProcessGroup = vi.fn()

      forceKillPosixPtyProcessGroups(100, fallback, {
        platform: 'darwin',
        currentPid: 999,
        readProcessTable: () => {
          throw new Error('ps timed out')
        },
        readDescendantTable: () => `
          200    1  200
        `,
        signalProcessGroup
      })

      expect(signalProcessGroup).not.toHaveBeenCalled()
      expect(fallback).toHaveBeenCalledOnce()
    })

    it('prefers the TTY table when it answers, so the proven path is unchanged', () => {
      const readDescendantTable = vi.fn(() => TREE)
      const signalProcessGroup = vi.fn()

      forceKillPosixPtyProcessGroups(100, vi.fn(), {
        platform: 'darwin',
        currentPid: 999,
        readProcessTable: () => TABLE,
        readDescendantTable,
        signalProcessGroup
      })

      expect(readDescendantTable).not.toHaveBeenCalled()
      expect(signalProcessGroup.mock.calls.map(([pgid]) => pgid)).toEqual([101, 103, 100])
    })
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
