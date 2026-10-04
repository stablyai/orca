import { beforeEach, describe, expect, it, vi } from 'vitest'
const runProcessSyncMock = vi.hoisted(() => vi.fn())
vi.mock('../../shared/child-process/run-process', () => ({
  runProcessSync: runProcessSyncMock,
  runProcess: vi.fn()
}))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: vi.fn()
}))
import {
  forceKillPosixPtyProcessGroups,
  resetPosixPtyProcessTableDialectForTests
} from './posix-pty-process-groups'

beforeEach(() => {
  runProcessSyncMock.mockReset()
  resetPosixPtyProcessTableDialectForTests()
})

describe('shared Codex daemon on a PTY during force teardown', () => {
  it.each(['darwin', 'linux'] as const)(
    'uses scoped root termination on %s when a managed daemon shares the TTY',
    (platform) => {
      const fallback = vi.fn()
      const signalProcessGroup = vi.fn()
      forceKillPosixPtyProcessGroups(100, fallback, {
        platform,
        currentPid: 999,
        readProcessTable: () =>
          [
            '100 100 ttys001 S /bin/zsh',
            '110 110 ttys001 S codex',
            '120 120 ttys001 S /opt/bin/codex app-server --listen unix:// --managed-daemon',
            '130 130 ttys001 S node shared-tool.js',
            '140 140 ttys001 S codex app-server daemon pid-update-loop'
          ].join('\n'),
        signalProcessGroup
      })
      expect(fallback).toHaveBeenCalledOnce()
      expect(signalProcessGroup).not.toHaveBeenCalled()
    }
  )

  it('also protects the maintenance service when the app-server has no TTY', () => {
    const fallback = vi.fn()
    const signalProcessGroup = vi.fn()
    forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'darwin',
      currentPid: 999,
      readProcessTable: () =>
        [
          '100 100 ttys001 S /bin/zsh',
          '120 120 ?? S codex app-server --managed-daemon',
          '140 140 ttys001 S codex app-server daemon pid-update-loop',
          '150 150 ttys001 S sleep 10'
        ].join('\n'),
      signalProcessGroup
    })
    expect(fallback).toHaveBeenCalledOnce()
    expect(signalProcessGroup).not.toHaveBeenCalled()
  })

  it('still kills ordinary Codex app-servers and ignores services on other TTYs', () => {
    const fallback = vi.fn()
    const signalProcessGroup = vi.fn()
    forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'darwin',
      currentPid: 999,
      readProcessTable: () =>
        [
          '100 100 ttys001 S /bin/zsh',
          '110 110 ttys001 S codex app-server',
          '120 120 ttys002 S codex app-server --managed-daemon',
          '140 140 ?? S codex app-server daemon pid-update-loop'
        ].join('\n'),
      signalProcessGroup
    })
    expect(fallback).not.toHaveBeenCalled()
    expect(signalProcessGroup.mock.calls).toEqual([[110], [100]])
  })
})

describe('force teardown command capture', () => {
  it('queries only leaders on this TTY and protects a managed daemon', () => {
    runProcessSyncMock
      .mockReturnValueOnce({ code: 0, stdout: '100 100 ttys001 S' })
      .mockReturnValueOnce({
        code: 0,
        stdout: '100 100 ttys001 S\n120 120 ttys001 S\n121 120 ttys001 S\n130 130 ttys001 S'
      })
      .mockReturnValueOnce({
        code: 0,
        stdout:
          '100 100 ttys001 S /bin/zsh\n120 120 ttys001 S codex app-server --managed-daemon\n130 130 ttys001 S node tool.js'
      })
    const fallback = vi.fn()
    const signalProcessGroup = vi.fn()
    forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'darwin',
      currentPid: 999,
      signalProcessGroup
    })
    expect(runProcessSyncMock.mock.calls.map(([spec]) => spec.args)).toEqual([
      ['-p', '100', '-o', 'pid=,pgid=,tty=,stat='],
      ['-t', 'ttys001', '-o', 'pid=,pgid=,tty=,stat='],
      ['-ww', '-p', '100,120,130', '-o', 'pid=,pgid=,tty=,stat=,command=']
    ])
    expect(fallback).toHaveBeenCalledOnce()
    expect(signalProcessGroup).not.toHaveBeenCalled()
  })

  it.each([
    { code: 1, stdout: '', stderr: 'ps: unrecognized option: p' },
    { code: 0, stdout: '', timedOut: true },
    { code: 0, stdout: '', outputTruncated: true },
    { code: 0, stdout: '100 100 ttys001 S /bin/zsh' },
    { code: 0, stdout: '100 100 ttys001 S /bin/zsh\n120 120 ttys002 S codex' }
  ])('does not group-kill when ownership inspection is unavailable: %j', (result) => {
    runProcessSyncMock
      .mockReturnValueOnce({ code: 0, stdout: '100 100 ttys001 S' })
      .mockReturnValueOnce({ code: 0, stdout: '100 100 ttys001 S\n120 120 ttys001 S' })
      .mockReturnValueOnce(result)
    const fallback = vi.fn()
    const signalProcessGroup = vi.fn()
    forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'linux',
      currentPid: 999,
      signalProcessGroup
    })
    expect(fallback).toHaveBeenCalledOnce()
    expect(signalProcessGroup).not.toHaveBeenCalled()
  })

  it('continues group teardown when captured leaders are terminal-owned', () => {
    runProcessSyncMock
      .mockReturnValueOnce({ code: 0, stdout: '100 100 ttys001 S' })
      .mockReturnValueOnce({ code: 0, stdout: '100 100 ttys001 S\n120 120 ttys001 S' })
      .mockReturnValueOnce({
        code: 0,
        stdout: '100 100 ttys001 S /bin/zsh\n120 120 ttys001 S codex app-server'
      })
    const fallback = vi.fn()
    const signalProcessGroup = vi.fn()
    forceKillPosixPtyProcessGroups(100, fallback, {
      platform: 'darwin',
      currentPid: 999,
      signalProcessGroup
    })
    expect(fallback).not.toHaveBeenCalled()
    expect(signalProcessGroup.mock.calls).toEqual([[120], [100]])
  })
})
