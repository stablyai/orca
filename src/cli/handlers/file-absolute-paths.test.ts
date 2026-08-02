import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    readonly isRemote = false
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

  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

import { main } from '../index'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from '../test-fixtures'

describe('absolute file CLI paths', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('reproduces the issue positional WSL command without invalid_relative_path', async () => {
    const issuePath = '/root/orca/workspaces/xxx/xxx/xxx.ts'
    callMock.mockImplementation(async (method: string, params: { relativePath?: string }) => {
      if (method === 'worktree.list') {
        return worktreeListFixture([buildWorktree('/root/orca/workspaces/xxx', 'feature')])
      }
      if (method === 'worktree.show') {
        return okFixture('req_show', {
          worktree: buildWorktree('/root/orca/workspaces/xxx', 'feature')
        })
      }
      if (method === 'files.open' && params.relativePath?.startsWith('/')) {
        throw new Error('invalid_relative_path')
      }
      return okFixture('req_open', {
        worktree: 'wt-1',
        relativePath: params.relativePath,
        kind: 'text',
        opened: true
      })
    })

    await main(['file', 'open', issuePath], '/root/orca/workspaces/xxx')

    expect(process.exitCode).toBeUndefined()
    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.show', {
      worktree: 'id:repo::/root/orca/workspaces/xxx'
    })
    expect(callMock).toHaveBeenNthCalledWith(3, 'files.open', {
      worktree: 'id:repo::/root/orca/workspaces/xxx',
      relativePath: 'xxx/xxx.ts'
    })
  })

  it('relativizes absolute file diff paths', async () => {
    queueFixtures(
      callMock,
      okFixture('req_show', { worktree: buildWorktree('/tmp/repo', 'feature') }),
      okFixture('req_diff', {
        worktree: 'wt-1',
        relativePath: 'src/App.tsx',
        kind: 'text',
        opened: true
      })
    )

    await main(
      ['file', 'diff', '--path', '/tmp/repo/src/App.tsx', '--worktree', 'id:wt-1', '--staged'],
      '/tmp'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.show', { worktree: 'id:wt-1' })
    expect(callMock).toHaveBeenNthCalledWith(2, 'files.openDiff', {
      worktree: 'id:wt-1',
      relativePath: 'src/App.tsx',
      staged: true
    })
  })

  it('keeps relative paths on the single-rpc path', async () => {
    queueFixtures(
      callMock,
      okFixture('req_open', {
        worktree: 'wt-1',
        relativePath: 'src/App.tsx',
        kind: 'text',
        opened: true
      })
    )

    await main(['file', 'open', '--path', 'src/App.tsx', '--worktree', 'id:wt-1'], '/tmp')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('files.open', {
      worktree: 'id:wt-1',
      relativePath: 'src/App.tsx'
    })
  })

  it('leaves outside-worktree absolute paths for the runtime guard', async () => {
    const absolutePath = '/tmp/elsewhere/App.tsx'
    queueFixtures(
      callMock,
      okFixture('req_show', { worktree: buildWorktree('/tmp/repo', 'feature') }),
      okFixture('req_open', {
        worktree: 'wt-1',
        relativePath: absolutePath,
        kind: 'text',
        opened: true
      })
    )

    await main(['file', 'open', '--path', absolutePath, '--worktree', 'id:wt-1'], '/tmp')

    expect(callMock).toHaveBeenNthCalledWith(2, 'files.open', {
      worktree: 'id:wt-1',
      relativePath: absolutePath
    })
  })

  it('rejects the worktree root as a file-open target', async () => {
    queueFixtures(
      callMock,
      okFixture('req_show', { worktree: buildWorktree('/tmp/repo', 'feature') })
    )

    await main(['file', 'open', '--path', '/tmp/repo', '--worktree', 'id:wt-1'], '/tmp')

    expect(process.exitCode).toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      'The selected worktree root is a directory, not a file-open target.'
    )
    expect(callMock).toHaveBeenCalledTimes(1)
  })
})
