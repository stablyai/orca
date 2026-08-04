import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import { resolveAgentForegroundProcessWithAvailability } from './agent-foreground-process'
import { resetWindowsProcessRowsSnapshotForTests } from './windows-foreground-process-rows'

describe('Pi Windows foreground recognition', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
    resetWindowsProcessRowsSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('recognizes the npm entrypoint within the active ConPTY', async () => {
    const rows = JSON.stringify([
      {
        CommandLine: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        ExecutablePath: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        Name: 'bash.exe',
        ParentProcessId: 99,
        ProcessId: 100
      },
      {
        CommandLine:
          'node.exe C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js',
        ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
        Name: 'node.exe',
        ParentProcessId: 100,
        ProcessId: 101
      }
    ])
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _options: unknown, callback: unknown) => {
        const done = callback as (error: null, result: { stdout: string; stderr: string }) => void
        done(null, {
          stdout: rows,
          stderr: ''
        })
      }
    )
    const readWindowsConptyProcessIds = vi.fn(async () => new Set([100, 101]))

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'node.exe', {
        fresh: true,
        readWindowsConptyProcessIds
      })
    ).resolves.toEqual({ available: true, processName: 'pi' })
    expect(readWindowsConptyProcessIds).toHaveBeenCalledTimes(1)
  })
})
