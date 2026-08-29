import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ execFile: execFileMock }))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import { inspectAgentPtyProcess, inspectPtyChildProcesses } from './agent-foreground-process'

function mockPs(stdout: string): void {
  execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
    callback(null, { stdout, stderr: '' })
  })
}

describe('agent PTY process inspection', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('resolves POSIX identity and children from one fresh snapshot', async () => {
    mockPs(['100 99 Ss+  /bin/zsh -l', '101 100 S+   sleep 100'].join('\n'))

    await expect(inspectAgentPtyProcess(100, 'zsh')).resolves.toEqual({
      available: true,
      processName: 'zsh',
      hasChildProcesses: true
    })
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('reports an available child-free POSIX shell', async () => {
    mockPs('100 99 Ss+  /bin/zsh -l')
    await expect(inspectAgentPtyProcess(100, 'zsh')).resolves.toEqual({
      available: true,
      processName: 'zsh',
      hasChildProcesses: false
    })
  })

  it('treats a missing POSIX root and failed scan as unavailable', async () => {
    mockPs('101 999 S+ sleep 100')
    await expect(inspectPtyChildProcesses(100)).resolves.toEqual({
      available: false,
      hasChildProcesses: false
    })

    resetProcessTableSnapshotForTests()
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(new Error('ps unavailable'), { stdout: '', stderr: '' })
    })
    await expect(inspectPtyChildProcesses(100)).resolves.toEqual({
      available: false,
      hasChildProcesses: false
    })
  })

  it('reads Windows child evidence from ConPTY membership', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    await expect(
      inspectPtyChildProcesses(100, {
        readWindowsPtyJobProcessIds: async () => new Set([100, 101])
      })
    ).resolves.toEqual({ available: true, hasChildProcesses: true })
    await expect(
      inspectPtyChildProcesses(100, { readWindowsPtyJobProcessIds: async () => new Set([100]) })
    ).resolves.toEqual({ available: true, hasChildProcesses: false })
    await expect(
      inspectPtyChildProcesses(100, { readWindowsPtyJobProcessIds: async () => null })
    ).resolves.toEqual({ available: false, hasChildProcesses: false })
  })
})
