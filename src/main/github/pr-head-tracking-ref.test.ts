import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshGitProvider } from '../providers/ssh-git-provider'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { fetchPrHeadTrackingRef } from './pr-head-tracking-ref'

describe('fetchPrHeadTrackingRef', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
  })

  it('fetches into the remote-tracking ref with real git for local repos', async () => {
    await fetchPrHeadTrackingRef({ path: '/repo', connectionId: null }, null, 'origin', 'feature/x')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['fetch', 'origin', '+refs/heads/feature/x:refs/remotes/origin/feature/x'],
      { cwd: '/repo' }
    )
  })

  it('uses the SSH tracking-ref RPC for connected repos and never runs git directly', async () => {
    const fetchRemoteTrackingRef = vi.fn(async () => {})

    await fetchPrHeadTrackingRef(
      { path: '/repo', connectionId: 'conn-1' },
      { fetchRemoteTrackingRef } as unknown as SshGitProvider,
      'origin',
      'feature/x'
    )

    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/repo',
      'origin',
      'feature/x',
      'refs/remotes/origin/feature/x'
    )
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('throws when a connected repo has no available SSH provider', async () => {
    await expect(
      fetchPrHeadTrackingRef({ path: '/repo', connectionId: 'conn-1' }, null, 'origin', 'feature/x')
    ).rejects.toThrow('SSH Git provider is not available')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
