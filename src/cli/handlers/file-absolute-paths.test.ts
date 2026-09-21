import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    // Why: a contributor running this suite inside WSL inherits a real
    // WSL_DISTRO_NAME, which would flip the rewrite on for every case below.
    vi.stubEnv('WSL_DISTRO_NAME', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reproduces the issue positional command without invalid_relative_path', async () => {
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

  describe('WSL UNC worktree roots', () => {
    const uncRoot = '//wsl.localhost/Ubuntu/root/orca/workspaces/xxx'

    function mockWorktreeShow(rootPath: string): void {
      queueFixtures(
        callMock,
        okFixture('req_show', { worktree: buildWorktree(rootPath, 'feature') }),
        okFixture('req_open', {
          worktree: 'wt-1',
          relativePath: 'xxx/xxx.ts',
          kind: 'text',
          opened: true
        })
      )
    }

    function expectOpenedWith(relativePath: string): void {
      expect(process.exitCode).toBeUndefined()
      expect(callMock).toHaveBeenNthCalledWith(2, 'files.open', {
        worktree: 'id:wt-1',
        relativePath
      })
    }

    async function openPath(path: string, cwd = '/tmp'): Promise<void> {
      await main(['file', 'open', '--path', path, '--worktree', 'id:wt-1'], cwd)
    }

    it('relativizes a Linux path typed inside the distro against the UNC root', async () => {
      vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
      mockWorktreeShow(uncRoot)

      await openPath('/root/orca/workspaces/xxx/xxx/xxx.ts')

      expectOpenedWith('xxx/xxx.ts')
    })

    it('relativizes against a legacy backslash wsl$ root', async () => {
      vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
      mockWorktreeShow('\\\\wsl$\\Ubuntu\\root\\orca\\workspaces\\xxx')

      await openPath('/root/orca/workspaces/xxx/xxx/xxx.ts')

      expectOpenedWith('xxx/xxx.ts')
    })

    it('does not double-prefix a UNC path the user already typed', async () => {
      vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
      mockWorktreeShow(uncRoot)

      await openPath(`${uncRoot}/xxx/xxx.ts`)

      expectOpenedWith('xxx/xxx.ts')
    })

    // Why: backslash is a legal Linux filename character, but reads as a separator
    // once the path is UNC — rewriting `a\b.ts` would open `a/b.ts` instead.
    it('leaves a Linux path containing a backslash for the runtime guard', async () => {
      vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
      mockWorktreeShow(uncRoot)

      await openPath('/root/orca/workspaces/xxx/a\\b.ts')

      expectOpenedWith('/root/orca/workspaces/xxx/a\\b.ts')
    })

    it('leaves a Linux path from another distro for the runtime guard', async () => {
      vi.stubEnv('WSL_DISTRO_NAME', 'Debian')
      mockWorktreeShow(uncRoot)

      await openPath('/root/orca/workspaces/xxx/xxx/xxx.ts')

      expectOpenedWith('/root/orca/workspaces/xxx/xxx/xxx.ts')
    })

    // Why: WSL_DISTRO_NAME is also set for a plain Linux CLI inside the distro, where
    // roots are POSIX; prefixing there would strand every absolute path (#11393 regression).
    it('keeps relativizing POSIX roots while WSL_DISTRO_NAME is set', async () => {
      vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
      mockWorktreeShow('/root/orca/workspaces/xxx')

      await openPath('/root/orca/workspaces/xxx/xxx/xxx.ts')

      expectOpenedWith('xxx/xxx.ts')
    })

    it('does not relativize a sibling directory that merely shares the root prefix', async () => {
      vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
      mockWorktreeShow(uncRoot)

      await openPath('/root/orca/workspaces/xxx-2/xxx.ts')

      expectOpenedWith('/root/orca/workspaces/xxx-2/xxx.ts')
    })

    // Why: Windows folds the distro segment, so only its case may differ from the root.
    it('matches when only the distro case differs', async () => {
      vi.stubEnv('WSL_DISTRO_NAME', 'ubuntu')
      mockWorktreeShow(uncRoot)

      await openPath('/root/orca/workspaces/xxx/xxx/xxx.ts')

      expectOpenedWith('xxx/xxx.ts')
    })

    it('leaves a Linux path whose own case does not match the root', async () => {
      vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
      mockWorktreeShow(uncRoot)

      await openPath('/root/orca/Workspaces/xxx/xxx.ts')

      expectOpenedWith('/root/orca/Workspaces/xxx/xxx.ts')
    })

    it('leaves a Windows drive-letter workspace alone while WSL_DISTRO_NAME is set', async () => {
      vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
      mockWorktreeShow('C:\\Users\\me\\repo')

      await openPath('C:/Users/me/repo/xxx/xxx.ts')

      expectOpenedWith('xxx/xxx.ts')
    })

    // Why: WSL_DISTRO_NAME only arrives if interop forwards it, but the launcher
    // always sets ORCA_CLI_CWD, which reaches the handler as the invocation cwd.
    it('falls back to the distro named by a UNC cwd', async () => {
      mockWorktreeShow(uncRoot)

      await openPath(
        '/root/orca/workspaces/xxx/xxx/xxx.ts',
        '\\\\wsl.localhost\\Ubuntu\\root\\orca\\workspaces\\xxx\\xxx'
      )

      expectOpenedWith('xxx/xxx.ts')
    })

    it('does not rewrite when the CLI is not running under WSL', async () => {
      mockWorktreeShow(uncRoot)

      await openPath('/root/orca/workspaces/xxx/xxx/xxx.ts')

      expectOpenedWith('/root/orca/workspaces/xxx/xxx/xxx.ts')
    })

    it('rejects the UNC worktree root itself typed as a Linux path', async () => {
      vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
      queueFixtures(
        callMock,
        okFixture('req_show', { worktree: buildWorktree(uncRoot, 'feature') })
      )

      await openPath('/root/orca/workspaces/xxx')

      expect(process.exitCode).toBe(1)
      expect(console.error).toHaveBeenCalledWith(
        'The selected worktree root is a directory, not a file-open target.'
      )
      expect(callMock).toHaveBeenCalledTimes(1)
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
