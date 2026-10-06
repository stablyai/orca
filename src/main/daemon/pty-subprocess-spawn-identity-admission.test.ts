import { afterEach, describe, expect, it, vi } from 'vitest'

const { proc, readPtyRootCreationTimeMs, readFreshRows, createHandle } = vi.hoisted(() => {
  const proc = { pid: 4242, onExit: vi.fn() }
  return {
    proc,
    readPtyRootCreationTimeMs: vi.fn(() => {
      expect(proc.onExit).toHaveBeenCalledOnce()
      return 1234
    }),
    readFreshRows: vi.fn(() => new Promise<never>(() => {})),
    createHandle: vi.fn(() => {
      proc.onExit(() => {})
      return { pid: 4242, spawnIdentity: { ptyTreeId: 'owned-tree' } }
    })
  }
})

vi.mock('./pty-subprocess/spawn-environment', () => ({ createDaemonPtyEnvironment: () => ({}) }))
vi.mock('./pty-subprocess/shell-launch-plan', () => ({
  createPtyShellLaunchPlan: () => ({
    shellPath: 'cmd.exe',
    shellArgs: [],
    spawnCwd: 'C:\\',
    windowsFallbackAttempts: []
  })
}))
vi.mock('./pty-subprocess/spawn-preflight', () => ({ preflightPtySpawn: async () => {} }))
vi.mock('./pty-subprocess/native-pty-spawn', () => ({
  spawnNativeDaemonPty: async () => ({
    process: proc,
    shellPath: 'cmd.exe',
    spawnCwd: 'C:\\',
    reportsChildExitStatus: true
  })
}))
vi.mock('./pty-subprocess/subprocess-handle', () => ({
  createDaemonPtySubprocessHandle: createHandle
}))
vi.mock('../windows/windows-pty-job', () => ({ readPtyRootCreationTimeMs }))
vi.mock('../windows/windows-process-table', () => ({
  isWindowsProcessStartTimeAvailable: () => true,
  readWindowsProcessTableFresh: readFreshRows,
  readWindowsProcessIdentityTableFresh: readFreshRows
}))

import { createPtySubprocess } from './pty-subprocess'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.useRealTimers()
})

describe('Windows PTY identity admission', () => {
  it('publishes a spawn baseline after listeners attach without waiting on table scans', async () => {
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let settled = false
    const pending = createPtySubprocess({ sessionId: 'identity-admission', cols: 80, rows: 24 })
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    expect(readFreshRows).not.toHaveBeenCalled()
    expect(readPtyRootCreationTimeMs).toHaveBeenCalledWith(proc)
    expect((await pending).spawnIdentity).toEqual({
      ptyTreeId: 'owned-tree',
      rootCreationTimeMs: 1234
    })
  })
})
