// A canceled cwd probe must leave the daemon as the one cancellation identity
// the wire carries. Clients key recovery off it, and an unrecognized message
// takes the rollback branch that closes a terminal the user still has (#7718).
import { describe, expect, it, vi } from 'vitest'
import type * as LocalPtyUtils from '../providers/local-pty-utils'

const {
  spawnMock,
  isPwshAvailableMock,
  validateWorkingDirectoryMock,
  validateWorkingDirectoryAsyncMock,
  resolveUnixShellPathMock,
  resolveAgentForegroundProcessMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  isPwshAvailableMock: vi.fn(),
  resolveUnixShellPathMock: vi.fn((shellPath: string) => shellPath),
  resolveAgentForegroundProcessMock: vi.fn(),
  validateWorkingDirectoryMock: vi.fn(),
  validateWorkingDirectoryAsyncMock: vi.fn()
}))

vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('../pwsh', () => ({ isPwshAvailable: isPwshAvailableMock }))

vi.mock('../providers/local-pty-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalPtyUtils>()
  return {
    ...actual,
    resolveUnixShellPath: resolveUnixShellPathMock,
    validateWorkingDirectory: validateWorkingDirectoryMock,
    validateWorkingDirectoryAsync: validateWorkingDirectoryAsyncMock
  }
})

vi.mock('../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: async (...args: unknown[]) => {
    const value = await resolveAgentForegroundProcessMock(...args)
    return value && typeof value === 'object' && 'available' in value
      ? value
      : { available: true, processName: value }
  }
}))

vi.mock('../providers/windows-conpty-process-membership', () => ({
  readWindowsConptyProcessIds: () => Promise.resolve(new Set([12345]))
}))

import { createPtySubprocess } from './pty-subprocess'
import { TerminalAttachCanceledError } from './daemon-errors'
import { WorkingDirectoryValidationAbortedError } from '../providers/working-directory-validation'
import { useDaemonPtySubprocessEnv } from './pty-subprocess-test-harness'

describe('createPtySubprocess cwd cancellation identity', () => {
  useDaemonPtySubprocessEnv({
    spawnMock,
    isPwshAvailableMock,
    resolveUnixShellPathMock,
    resolveAgentForegroundProcessMock,
    validateWorkingDirectoryMock
  })

  it('reports a canceled cwd probe as an attach cancellation, not a spawn failure', async () => {
    validateWorkingDirectoryAsyncMock.mockRejectedValue(
      new WorkingDirectoryValidationAbortedError('/Volumes/dead/repo')
    )
    const abort = new AbortController()
    abort.abort()

    await expect(
      createPtySubprocess({
        sessionId: 'canceled-cwd-session',
        cols: 80,
        rows: 24,
        cwd: '/Volumes/dead/repo',
        cancelSignal: abort.signal
      })
    ).rejects.toThrow(TerminalAttachCanceledError)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('leaves a genuine missing-directory failure alone', async () => {
    validateWorkingDirectoryAsyncMock.mockRejectedValue(
      new Error('Working directory "/gone" does not exist. It may have been deleted.')
    )

    await expect(
      createPtySubprocess({
        sessionId: 'missing-cwd-session',
        cols: 80,
        rows: 24,
        cwd: '/gone'
      })
    ).rejects.toThrow(/does not exist/)
  })
})
