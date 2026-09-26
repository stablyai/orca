import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot-reader'
import { confirmShellForegroundProcess } from './agent-foreground-process'

// Why: the POSIX reader wraps execFile with promisify, so the mock must honor the Node callback contract.
function mockPs(stdout: string): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: unknown, result: { stdout: string; stderr: string }) => void
    ) => {
      callback(null, { stdout, stderr: '' })
    }
  )
}

describe('confirmShellForegroundProcess with a spawned shell path', () => {
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

  it('confirms a shell whose path contains a space', async () => {
    mockPs(
      [
        '100 99 100 101 Ss /usr/bin/login -pfl developer /Users/John Doe/bin/zsh',
        '101 100 101 101 S+ -zsh'
      ].join('\n')
    )

    await expect(confirmShellForegroundProcess(100, '/Users/John Doe/bin/zsh')).resolves.toBe(true)
  })
})
