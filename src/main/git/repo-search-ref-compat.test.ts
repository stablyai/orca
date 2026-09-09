import { afterEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn()
}))

import { clearGitCapabilityStateForTests } from './git-capability-state'
import { searchBaseRefs } from './repo'

describe('searchBaseRefs git compatibility', () => {
  afterEach(() => {
    clearGitCapabilityStateForTests()
    gitExecFileAsyncMock.mockReset()
  })

  it('falls back when older git does not support for-each-ref --exclude', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args.some((arg) => arg.startsWith('--exclude=refs/remotes/'))) {
        throw Object.assign(new Error("unknown option `exclude'"), {
          stderr: "error: unknown option `exclude'"
        })
      }
      return {
        stdout: [
          'refs/remotes/origin/main\0origin/main',
          'refs/remotes/origin/HEAD\0origin/HEAD'
        ].join('\n'),
        stderr: ''
      }
    })

    await expect(searchBaseRefs('/repo', '', 1)).resolves.toEqual(['origin/main'])
    await expect(searchBaseRefs('/repo', '', 1)).resolves.toEqual(['origin/main'])
    const forEachRefCalls = gitExecFileAsyncMock.mock.calls.filter(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )
    expect(forEachRefCalls).toHaveLength(3)
    expect(
      (forEachRefCalls[0][0] as string[]).some((arg) => arg.startsWith('--exclude=refs/remotes/'))
    ).toBe(true)
    expect(
      (forEachRefCalls[1][0] as string[]).some((arg) => arg.startsWith('--exclude=refs/remotes/'))
    ).toBe(false)
    expect(forEachRefCalls[1][0]).toContain('--count=104')
    expect(
      (forEachRefCalls[2][0] as string[]).some((arg) => arg.startsWith('--exclude=refs/remotes/'))
    ).toBe(false)
  })
})
