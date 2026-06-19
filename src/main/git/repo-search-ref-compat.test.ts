import { afterEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn()
}))

import { searchBaseRefs } from './repo'

describe('searchBaseRefs git compatibility', () => {
  afterEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('falls back when older git does not support for-each-ref --exclude', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args.includes('--exclude=refs/remotes/**/HEAD')) {
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
    const forEachRefCalls = gitExecFileAsyncMock.mock.calls.filter(
      (call) => (call[0] as string[])[0] === 'for-each-ref'
    )
    expect(forEachRefCalls).toHaveLength(2)
    expect(forEachRefCalls[0][0]).toContain('--exclude=refs/remotes/**/HEAD')
    expect(forEachRefCalls[1][0]).not.toContain('--exclude=refs/remotes/**/HEAD')
    expect(forEachRefCalls[1][0]).toContain('--count=104')
  })
})
