import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  reportWindowsCommandLineRecoveryHealth,
  resetWindowsCommandLineRecoveryHealthForTests
} from './windows-command-line-recovery-health'

describe('windows command line recovery health', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetWindowsCommandLineRecoveryHealthForTests()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  const selfRow = (commandLine: string): { pid: number; commandLine: string } => ({
    pid: process.pid,
    commandLine
  })

  it('warns when the querying process has no command line of its own', () => {
    // We can always open ourselves with PROCESS_QUERY_LIMITED_INFORMATION, so
    // an empty self command line means the query is refused host-wide.
    reportWindowsCommandLineRecoveryHealth([selfRow(''), { pid: 4, commandLine: '' }])

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('ProcessCommandLineInformation')
    expect(warn.mock.calls[0][1]).toEqual({ processes: 2, withCommandLine: 0 })
  })

  it('warns once per session, not once per scan', () => {
    for (let i = 0; i < 5; i++) {
      reportWindowsCommandLineRecoveryHealth([selfRow('')])
    }
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when only other processes denied a handle', () => {
    // Roughly a quarter of a real table denies access; that is not a fault.
    const denied = Array.from({ length: 40 }, (_, index) => ({
      pid: index + 1,
      commandLine: ''
    }))
    reportWindowsCommandLineRecoveryHealth([selfRow('node.exe --run'), ...denied])
    expect(warn).not.toHaveBeenCalled()
  })

  it('stays quiet when our own row is absent, which the caller rejects separately', () => {
    reportWindowsCommandLineRecoveryHealth([{ pid: process.pid + 1, commandLine: '' }])
    expect(warn).not.toHaveBeenCalled()
  })

  it('treats a missing commandLine field the same as an empty one', () => {
    reportWindowsCommandLineRecoveryHealth([{ pid: process.pid }])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
