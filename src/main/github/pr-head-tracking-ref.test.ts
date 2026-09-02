import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshGitProvider } from '../providers/ssh-git-provider'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import {
  githubPullRequestHeadLocalRef,
  reviewHeadRemoteRefComponent,
  REVIEW_HEAD_FETCH_TIMEOUT_MS
} from '../../shared/review-head-tracking-ref'
import { fetchGitHubPullRequestHeadRef, fetchPrHeadTrackingRef } from './pr-head-tracking-ref'

const ORIGIN_URL = 'https://github.com/acme/widgets.git'
const ORIGIN_COMPONENT = reviewHeadRemoteRefComponent('origin', ORIGIN_URL)

describe('fetchPrHeadTrackingRef', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_URL}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
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

  it('fetches a GitHub pull head into its remote-scoped Orca ref for local repos', async () => {
    const localRef = await fetchGitHubPullRequestHeadRef(
      { path: '/repo', connectionId: null },
      null,
      'origin',
      42
    )

    // The fetch is bounded so a stalled remote can't hang PR resolution.
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'origin', `+refs/pull/42/head:refs/orca/pull/${ORIGIN_COMPONENT}/42`],
      { cwd: '/repo', timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
    )
    expect(localRef).toBe(githubPullRequestHeadLocalRef(ORIGIN_COMPONENT, 42))
    expect(localRef).toBe(`refs/orca/pull/${ORIGIN_COMPONENT}/42`)
  })

  it('fails the pull-head fetch when the remote is not configured', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error("fatal: No such remote 'origin'")
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      fetchGitHubPullRequestHeadRef({ path: '/repo', connectionId: null }, null, 'origin', 42)
    ).rejects.toThrow('Remote "origin" is not configured.')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['fetch']),
      expect.anything()
    )
  })

  it('keeps WSL routing while bounding the pull-head fetch', async () => {
    await fetchGitHubPullRequestHeadRef({ path: '/repo', connectionId: null }, null, 'origin', 42, {
      localGitExecOptions: { cwd: '/repo', wslDistro: 'Ubuntu' }
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo',
      wslDistro: 'Ubuntu'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'origin', `+refs/pull/42/head:refs/orca/pull/${ORIGIN_COMPONENT}/42`],
      { cwd: '/repo', wslDistro: 'Ubuntu', timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
    )
  })

  it('uses the SSH GitHub pull-head RPC and never runs git directly', async () => {
    const expectedRef = `refs/orca/pull/${ORIGIN_COMPONENT}/42`
    const fetchGitHubPullRequestHead = vi.fn(async () => expectedRef)

    const localRef = await fetchGitHubPullRequestHeadRef(
      { path: '/repo', connectionId: 'conn-1' },
      { fetchGitHubPullRequestHead } as unknown as SshGitProvider,
      'origin',
      42
    )

    expect(fetchGitHubPullRequestHead).toHaveBeenCalledWith('/repo', 'origin', 42)
    expect(localRef).toBe(expectedRef)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('rejects a connected GitHub pull-head fetch without an SSH provider', async () => {
    await expect(
      fetchGitHubPullRequestHeadRef({ path: '/repo', connectionId: 'conn-1' }, null, 'origin', 42)
    ).rejects.toThrow('SSH Git provider is not available')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('rejects invalid PR numbers and option-shaped remotes before running git', async () => {
    await expect(
      fetchGitHubPullRequestHeadRef({ path: '/repo', connectionId: null }, null, 'origin', 4.2)
    ).rejects.toThrow('Invalid pull request number')
    await expect(
      fetchGitHubPullRequestHeadRef(
        { path: '/repo', connectionId: null },
        null,
        '--upload-pack=x',
        42
      )
    ).rejects.toThrow('must not start with "-"')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
