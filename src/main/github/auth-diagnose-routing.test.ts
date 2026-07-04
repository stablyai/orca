import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, gitExecFileAsyncMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { _resetOwnerRepoCache } from './gh-utils'
import { diagnoseGhAuth } from './auth-diagnose'

describe('diagnoseGhAuth routing', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    _resetOwnerRepoCache()
  })

  it('checks auth status for the repo GitHub Enterprise host', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('upstream missing'))
      .mockResolvedValueOnce({ stdout: 'https://ghe.acme.internal/acme/orca.git\n' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '',
      stderr: `ghe.acme.internal
  ✓ Logged in to ghe.acme.internal account octocat (keyring)
  - Active account: true
  - Token scopes: 'project', 'read:org', 'repo'
`
    })

    const result = await diagnoseGhAuth({ repoPath: '/repo' })

    expect(result.activeAccount?.host).toBe('ghe.acme.internal')
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'ghe.acme.internal'],
      { cwd: '/repo' }
    )
  })
})
