import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('./runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { buildCurrentWorktreeSelector, main, normalizeWorktreeSelector } from './index'

describe('orca cli worktree awareness', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds the current worktree selector from cwd', () => {
    expect(buildCurrentWorktreeSelector('/tmp/repo/feature')).toBe('path:/tmp/repo/feature')
  })

  it('normalizes active/current worktree selectors to cwd', () => {
    expect(normalizeWorktreeSelector('active', '/tmp/repo/feature')).toBe('path:/tmp/repo/feature')
    expect(normalizeWorktreeSelector('current', '/tmp/repo/feature')).toBe('path:/tmp/repo/feature')
    expect(normalizeWorktreeSelector('branch:feature/foo', '/tmp/repo/feature')).toBe(
      'branch:feature/foo'
    )
  })

  it('shows the enclosing worktree for `worktree current`', async () => {
    callMock.mockResolvedValue({
      id: 'req_1',
      ok: true,
      result: {
        worktree: {
          id: 'repo::/tmp/repo/feature',
          branch: 'feature/foo',
          path: '/tmp/repo/feature'
        }
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'current', '--json'], '/tmp/repo/feature')

    expect(callMock).toHaveBeenCalledWith('worktree.show', {
      worktree: 'path:/tmp/repo/feature'
    })
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('uses cwd when active is passed to worktree.set', async () => {
    callMock.mockResolvedValue({
      id: 'req_1',
      ok: true,
      result: {
        worktree: {
          id: 'repo::/tmp/repo/feature',
          branch: 'feature/foo',
          path: '/tmp/repo/feature',
          comment: 'hello'
        }
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'set', '--worktree', 'active', '--comment', 'hello', '--json'],
      '/tmp/repo/feature'
    )

    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'path:/tmp/repo/feature',
      displayName: undefined,
      linkedIssue: undefined,
      comment: 'hello'
    })
  })
})
