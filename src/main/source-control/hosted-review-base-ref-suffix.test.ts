import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../github/gh-utils', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { baseRefExistsOnRemote } from './hosted-review-creation-git-state'

describe('baseRefExistsOnRemote suffix fallback', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('does not answer a bare base with a nested branch of the same final segment', async () => {
    // Suffix matches must have one remote segment; origin/feature/main cannot prove origin/main exists.
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref' && args.some((arg) => arg.startsWith('refs/remotes/'))) {
        throw Object.assign(new Error('missing ref'), { code: 1, stderr: '' })
      }
      if (args[0] === 'show-ref') {
        return { stdout: 'abc123 refs/remotes/origin/feature/main\n', stderr: '' }
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    await expect(baseRefExistsOnRemote('main', '/repo', 'local')).resolves.toBe(false)
  })

  it('still resolves a stale single-segment remote through the suffix fallback', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref' && args.some((arg) => arg.startsWith('refs/remotes/'))) {
        throw Object.assign(new Error('missing ref'), { code: 1, stderr: '' })
      }
      if (args[0] === 'show-ref') {
        return { stdout: 'abc123 refs/remotes/orphan/main\n', stderr: '' }
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    await expect(baseRefExistsOnRemote('main', '/repo', 'local')).resolves.toBe(true)
  })

  it('treats a suffix lookup that never ran as inconclusive', async () => {
    // A transport failure or output overflow must fail open, not assert absence.
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref' && args.some((arg) => arg.startsWith('refs/remotes/'))) {
        throw Object.assign(new Error('missing ref'), { code: 1, stderr: '' })
      }
      throw Object.assign(new Error('maxBuffer exceeded'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      })
    })

    await expect(baseRefExistsOnRemote('main', '/repo', 'local')).resolves.toBe(true)
  })
})
