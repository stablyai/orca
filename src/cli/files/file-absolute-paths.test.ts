import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime/client', () => {
  class RuntimeClient {
    readonly isRemote = false
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  return { RuntimeClient }
})

import { main } from '../index'
import { buildWorktree, okFixture, queueFixtures } from '../runtime/fixtures/runtime-rpc-fixtures'

describe('absolute file CLI paths', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.exitCode = undefined
    // Prevent a real WSL_DISTRO_NAME from enabling the rewrite in unrelated cases.
    vi.stubEnv('WSL_DISTRO_NAME', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('WSL UNC worktree roots', () => {
    const uncRoot = '//wsl.localhost/Ubuntu/root/orca/workspaces/xxx'

    async function openPath(path: string, cwd = '/tmp'): Promise<void> {
      await main(['file', 'open', '--path', path, '--worktree', 'id:wt-1'], cwd)
    }

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
})
