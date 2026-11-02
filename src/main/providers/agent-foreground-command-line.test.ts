import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot-reader'
import { resolveAgentForegroundCommandLine } from './agent-foreground-process'

// Why: the POSIX reader wraps execFile with promisify, so the mock honors the Node callback contract.
function mockPs(rows: string[]): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: unknown, result: { stdout: string; stderr: string }) => void
    ) => callback(null, { stdout: rows.join('\n'), stderr: '' })
  )
}

describe('resolveAgentForegroundCommandLine', () => {
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

  it("returns the foreground agent's full command line", async () => {
    mockPs([
      '100 99 100 101 Ss /bin/zsh -l',
      '101 100 101 101 S+ /opt/homebrew/bin/opencode run fix the bug',
      '102 100 102 101 S node background.js'
    ])

    await expect(resolveAgentForegroundCommandLine(100)).resolves.toBe(
      '/opt/homebrew/bin/opencode run fix the bug'
    )
  })

  it('returns null when no agent holds the foreground', async () => {
    mockPs([
      '100 99 100 102 Ss /bin/zsh -l',
      '101 100 101 102 T opencode run paused',
      '102 100 102 102 S+ vim notes.txt'
    ])

    await expect(resolveAgentForegroundCommandLine(100)).resolves.toBeNull()
  })

  it('returns null when the capture fails', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: unknown) => void) =>
        callback(new Error('ps failed'))
    )

    await expect(resolveAgentForegroundCommandLine(100)).resolves.toBeNull()
  })
})
