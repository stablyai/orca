import path from 'path'
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
    expect(buildCurrentWorktreeSelector('/tmp/repo/feature')).toBe(
      `path:${path.resolve('/tmp/repo/feature')}`
    )
  })

  it('normalizes active/current worktree selectors to cwd', () => {
    const resolved = path.resolve('/tmp/repo/feature')
    expect(normalizeWorktreeSelector('active', '/tmp/repo/feature')).toBe(`path:${resolved}`)
    expect(normalizeWorktreeSelector('current', '/tmp/repo/feature')).toBe(`path:${resolved}`)
    expect(normalizeWorktreeSelector('branch:feature/foo', '/tmp/repo/feature')).toBe(
      'branch:feature/foo'
    )
  })

  it('shows the enclosing worktree for `worktree current`', async () => {
    callMock
      .mockResolvedValueOnce({
        id: 'req_list',
        ok: true,
        result: {
          worktrees: [
            {
              id: 'repo::/tmp/repo/feature',
              repoId: 'repo',
              path: '/tmp/repo/feature',
              branch: 'feature/foo',
              linkedIssue: null,
              git: {
                path: '/tmp/repo/feature',
                head: 'abc',
                branch: 'feature/foo',
                isBare: false,
                isMainWorktree: false
              },
              displayName: '',
              comment: ''
            }
          ],
          totalCount: 1,
          truncated: false
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
      .mockResolvedValueOnce({
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

    await main(['worktree', 'current', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', {
      limit: 10_000
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.show', {
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
    })
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('uses cwd when active is passed to worktree.set', async () => {
    callMock
      .mockResolvedValueOnce({
        id: 'req_list',
        ok: true,
        result: {
          worktrees: [
            {
              id: 'repo::/tmp/repo',
              repoId: 'repo',
              path: '/tmp/repo',
              branch: 'main',
              linkedIssue: null,
              git: {
                path: '/tmp/repo',
                head: 'aaa',
                branch: 'main',
                isBare: false,
                isMainWorktree: false
              },
              displayName: '',
              comment: ''
            },
            {
              id: 'repo::/tmp/repo/feature',
              repoId: 'repo',
              path: '/tmp/repo/feature',
              branch: 'feature/foo',
              linkedIssue: null,
              git: {
                path: '/tmp/repo/feature',
                head: 'abc',
                branch: 'feature/foo',
                isBare: false,
                isMainWorktree: false
              },
              displayName: '',
              comment: ''
            }
          ],
          totalCount: 2,
          truncated: false
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
      .mockResolvedValueOnce({
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
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.set', {
      worktree: `path:${path.resolve('/tmp/repo/feature')}`,
      displayName: undefined,
      linkedIssue: undefined,
      comment: 'hello'
    })
  })

  it('uses the resolved enclosing worktree for other worktree consumers', async () => {
    callMock
      .mockResolvedValueOnce({
        id: 'req_list',
        ok: true,
        result: {
          worktrees: [
            {
              id: 'repo::/tmp/repo/feature',
              repoId: 'repo',
              path: '/tmp/repo/feature',
              branch: 'feature/foo',
              linkedIssue: null,
              git: {
                path: '/tmp/repo/feature',
                head: 'abc',
                branch: 'feature/foo',
                isBare: false,
                isMainWorktree: false
              },
              displayName: '',
              comment: ''
            }
          ],
          totalCount: 1,
          truncated: false
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
      .mockResolvedValueOnce({
        id: 'req_show',
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
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'show', '--worktree', 'current', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.show', {
      worktree: `path:${path.resolve('/tmp/repo/feature')}`
    })
  })

  it('uses the resolved enclosing worktree for terminal consumers', async () => {
    callMock
      .mockResolvedValueOnce({
        id: 'req_list',
        ok: true,
        result: {
          worktrees: [
            {
              id: 'repo::/tmp/repo/feature',
              repoId: 'repo',
              path: '/tmp/repo/feature',
              branch: 'feature/foo',
              linkedIssue: null,
              git: {
                path: '/tmp/repo/feature',
                head: 'abc',
                branch: 'feature/foo',
                isBare: false,
                isMainWorktree: false
              },
              displayName: '',
              comment: ''
            }
          ],
          totalCount: 1,
          truncated: false
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
      .mockResolvedValueOnce({
        id: 'req_term',
        ok: true,
        result: {
          terminals: [],
          totalCount: 0,
          truncated: false
        },
        _meta: {
          runtimeId: 'runtime-1'
        }
      })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list', '--worktree', 'active', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.list', {
      worktree: `path:${path.resolve('/tmp/repo/feature')}`,
      limit: undefined
    })
  })
})
