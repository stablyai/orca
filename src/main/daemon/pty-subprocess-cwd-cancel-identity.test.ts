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

// Why host-shaped: the daemon preflights an explicit cwd only where its host reads the
// path as absolute, so a POSIX-only fixture skips the Windows native-path check entirely
// and the probe this file is about never runs.
const DEAD_REPO_CWD =
  process.platform === 'win32' ? 'C:\\Volumes\\dead\\repo' : '/Volumes/dead/repo'
const MISSING_CWD = process.platform === 'win32' ? 'C:\\gone' : '/gone'

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
      new WorkingDirectoryValidationAbortedError(DEAD_REPO_CWD)
    )
    const abort = new AbortController()
    abort.abort()

    await expect(
      createPtySubprocess({
        sessionId: 'canceled-cwd-session',
        cols: 80,
        rows: 24,
        cwd: DEAD_REPO_CWD,
        cancelSignal: abort.signal
      })
    ).rejects.toThrow(TerminalAttachCanceledError)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('leaves a genuine missing-directory failure alone', async () => {
    validateWorkingDirectoryAsyncMock.mockRejectedValue(
      new Error(`Working directory "${MISSING_CWD}" does not exist. It may have been deleted.`)
    )

    await expect(
      createPtySubprocess({
        sessionId: 'missing-cwd-session',
        cols: 80,
        rows: 24,
        cwd: MISSING_CWD
      })
    ).rejects.toThrow(/does not exist/)
  })
})
