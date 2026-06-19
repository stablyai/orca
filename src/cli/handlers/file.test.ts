/* eslint-disable max-lines -- Why: file CLI coverage shares one mocked runtime setup across command contracts. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    readonly isRemote: boolean
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()

    constructor(
      _userDataPath?: string,
      _requestTimeoutMs?: number,
      remotePairingCode?: string | null,
      environmentSelector?: string | null
    ) {
      this.isRemote = Boolean(remotePairingCode || environmentSelector)
    }
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

import { main } from '../index'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from '../test-fixtures'

describe('orca file CLI handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('prints group help with file commands', async () => {
    await main(['file', '--help'], '/tmp/repo')

    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toContain('open')
    expect(output).toContain('diff')
    expect(output).toContain('open-changed')
  })

  it('opens a positional path in the inferred current worktree', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'feature')]),
      okFixture('req_open', {
        worktree: 'wt-1',
        relativePath: 'src/App.tsx',
        kind: 'text',
        opened: true
      })
    )

    await main(['file', 'open', 'src/App.tsx'], '/tmp/repo/src')

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'files.open', {
      worktree: 'id:repo::/tmp/repo',
      relativePath: 'src/App.tsx'
    })
    expect(vi.mocked(console.log).mock.calls[0][0]).toBe('Opened src/App.tsx.')
  })

  it('opens a staged diff for an explicit worktree without cwd inference', async () => {
    queueFixtures(
      callMock,
      okFixture('req_diff', {
        worktree: 'wt-1',
        relativePath: 'src/App.tsx',
        kind: 'text',
        opened: true
      })
    )

    await main(
      ['file', 'diff', '--path', 'src/App.tsx', '--staged', '--worktree', 'id:wt-1'],
      '/tmp/elsewhere'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('files.openDiff', {
      worktree: 'id:wt-1',
      relativePath: 'src/App.tsx',
      staged: true
    })
  })

  it('reports unopened direct diffs instead of formatting them as opened', async () => {
    queueFixtures(
      callMock,
      okFixture('req_diff', {
        worktree: 'wt-1',
        relativePath: 'assets/logo.png',
        kind: 'binary',
        opened: false
      })
    )

    await main(['file', 'diff', '--path', 'assets/logo.png', '--worktree', 'id:wt-1'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('files.openDiff', {
      worktree: 'id:wt-1',
      relativePath: 'assets/logo.png',
      staged: false
    })
    expect(vi.mocked(console.log).mock.calls[0][0]).toBe(
      'Did not open diff for assets/logo.png: binary file.'
    )
  })

  it('rejects --worktree without a value before cwd inference or RPC calls', async () => {
    const priorExitCode = process.exitCode

    await main(['file', 'open', 'src/App.tsx', '--worktree'], '/tmp/repo/src')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Missing value for --worktree.')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('opens git-changed files as diffs by default', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'feature')]),
      okFixture('req_status', {
        entries: [
          { path: 'src/App.tsx', status: 'modified', area: 'unstaged' },
          { path: 'package.json', status: 'modified', area: 'staged' },
          { path: 'docs/new.md', status: 'untracked', area: 'untracked' }
        ],
        conflictOperation: 'unknown'
      }),
      okFixture('req_diff_1', {
        worktree: 'wt-1',
        relativePath: 'src/App.tsx',
        kind: 'text',
        opened: true
      }),
      okFixture('req_diff_2', {
        worktree: 'wt-1',
        relativePath: 'package.json',
        kind: 'text',
        opened: true
      }),
      okFixture('req_diff_3', {
        worktree: 'wt-1',
        relativePath: 'docs/new.md',
        kind: 'markdown',
        opened: true
      })
    )

    await main(['file', 'open-changed'], '/tmp/repo/src')

    expect(callMock).toHaveBeenNthCalledWith(2, 'git.status', {
      worktree: 'id:repo::/tmp/repo'
    })
    expect(callMock).toHaveBeenNthCalledWith(3, 'files.openDiff', {
      worktree: 'id:repo::/tmp/repo',
      relativePath: 'src/App.tsx',
      staged: false
    })
    expect(callMock).toHaveBeenNthCalledWith(4, 'files.openDiff', {
      worktree: 'id:repo::/tmp/repo',
      relativePath: 'package.json',
      staged: true
    })
    expect(callMock).toHaveBeenNthCalledWith(5, 'files.openDiff', {
      worktree: 'id:repo::/tmp/repo',
      relativePath: 'docs/new.md',
      staged: false
    })
    expect(vi.mocked(console.log).mock.calls[0][0]).toBe('Opened 3 changed file targets.')
  })

  it('places unopened changed-file diffs in skipped instead of opened', async () => {
    queueFixtures(
      callMock,
      okFixture('req_status', {
        entries: [{ path: 'assets/logo.png', status: 'modified', area: 'unstaged' }],
        conflictOperation: 'unknown'
      }),
      okFixture('req_diff', {
        worktree: 'wt-1',
        relativePath: 'assets/logo.png',
        kind: 'binary',
        opened: false
      })
    )

    await main(['file', 'open-changed', '--worktree', 'id:wt-1', '--json'], '/tmp/elsewhere')

    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0])
    expect(output.result.opened).toEqual([])
    expect(output.result.skipped).toEqual([
      {
        path: 'assets/logo.png',
        mode: 'diff',
        staged: false,
        opened: false,
        kind: 'binary',
        skipped: true,
        reason: 'binary file'
      }
    ])
  })

  it('skips unresolved conflict entries in diff mode without opening a normal diff', async () => {
    queueFixtures(
      callMock,
      okFixture('req_status', {
        entries: [
          {
            path: 'src/conflicted.ts',
            status: 'modified',
            area: 'unstaged',
            conflictStatus: 'unresolved'
          },
          { path: 'src/App.tsx', status: 'modified', area: 'staged' }
        ],
        conflictOperation: 'merge'
      }),
      okFixture('req_diff', {
        worktree: 'wt-1',
        relativePath: 'src/App.tsx',
        kind: 'text',
        opened: true
      })
    )

    await main(['file', 'open-changed', '--worktree', 'id:wt-1'], '/tmp/elsewhere')

    expect(callMock).toHaveBeenCalledTimes(2)
    expect(callMock).toHaveBeenNthCalledWith(1, 'git.status', { worktree: 'id:wt-1' })
    expect(callMock).toHaveBeenNthCalledWith(2, 'files.openDiff', {
      worktree: 'id:wt-1',
      relativePath: 'src/App.tsx',
      staged: true
    })
    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toContain('Opened 1 changed file targets.')
    expect(output).toContain(
      'src/conflicted.ts: unresolved conflict may not have a single diff target'
    )
  })

  it('opens changed files in both edit and diff modes while skipping deleted edit targets', async () => {
    queueFixtures(
      callMock,
      okFixture('req_status', {
        entries: [
          { path: 'src/App.tsx', status: 'modified', area: 'unstaged' },
          { path: 'src/App.tsx', status: 'modified', area: 'staged' },
          { path: 'docs/old.md', status: 'deleted', area: 'unstaged' }
        ],
        conflictOperation: 'unknown'
      }),
      okFixture('req_open', {
        worktree: 'wt-1',
        relativePath: 'src/App.tsx',
        kind: 'text',
        opened: true
      }),
      okFixture('req_diff_1', {
        worktree: 'wt-1',
        relativePath: 'src/App.tsx',
        kind: 'text',
        opened: true
      }),
      okFixture('req_diff_2', {
        worktree: 'wt-1',
        relativePath: 'src/App.tsx',
        kind: 'text',
        opened: true
      }),
      okFixture('req_diff_3', {
        worktree: 'wt-1',
        relativePath: 'docs/old.md',
        kind: 'markdown',
        opened: true
      })
    )

    await main(
      ['file', 'open-changed', '--mode', 'both', '--worktree', 'id:wt-1'],
      '/tmp/elsewhere'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'git.status', { worktree: 'id:wt-1' })
    expect(callMock).toHaveBeenNthCalledWith(2, 'files.open', {
      worktree: 'id:wt-1',
      relativePath: 'src/App.tsx'
    })
    expect(callMock).toHaveBeenNthCalledWith(3, 'files.openDiff', {
      worktree: 'id:wt-1',
      relativePath: 'src/App.tsx',
      staged: false
    })
    expect(callMock).toHaveBeenNthCalledWith(4, 'files.openDiff', {
      worktree: 'id:wt-1',
      relativePath: 'src/App.tsx',
      staged: true
    })
    expect(callMock).toHaveBeenNthCalledWith(5, 'files.openDiff', {
      worktree: 'id:wt-1',
      relativePath: 'docs/old.md',
      staged: false
    })
    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toContain('Opened 4 changed file targets.')
    expect(output).toContain('docs/old.md: deleted file has no edit target')
  })

  it('requires an explicit worktree for remote file commands', async () => {
    const priorExitCode = process.exitCode

    await main(['file', 'open-changed', '--pairing-code', 'remote-runtime'], '/tmp/repo/src')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Remote file commands require --worktree'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('rejects --mode without a value before cwd inference or RPC calls', async () => {
    const priorExitCode = process.exitCode

    await main(['file', 'open-changed', '--mode'], '/tmp/repo/src')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Missing value for --mode. Use edit, diff, or both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('validates mode before resolving a worktree', async () => {
    const priorExitCode = process.exitCode

    await main(['file', 'open-changed', '--mode', 'invalid'], '/tmp/repo/src')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Invalid --mode. Use edit, diff, or both.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
