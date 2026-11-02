import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import {
  reviewHeadRemoteRefComponent,
  REVIEW_HEAD_FETCH_TIMEOUT_MS
} from '../../shared/review-head-tracking-ref'
import { fetchGiteaPullRequestHeadRef } from './pr-head-tracking-ref'

const ORIGIN_URL = 'https://git.example.com/acme/widgets.git'
const ORIGIN_COMPONENT = reviewHeadRemoteRefComponent('origin', ORIGIN_URL)
const LOCAL_REF = `refs/orca/review-heads/${ORIGIN_COMPONENT}/pr-42`

describe('fetchGiteaPullRequestHeadRef', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_URL}\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
  })

  it('fetches a Gitea pull head into its remote-scoped Orca ref', async () => {
    const localRef = await fetchGiteaPullRequestHeadRef(
      { path: '/repo', connectionId: null },
      'origin',
      42
    )

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'origin', `+refs/pull/42/head:${LOCAL_REF}`],
      { cwd: '/repo', timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
    )
    expect(localRef).toBe(LOCAL_REF)
  })

  it('fails the pull-head fetch when the remote is not configured', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error("fatal: No such remote 'origin'")
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      fetchGiteaPullRequestHeadRef({ path: '/repo', connectionId: null }, 'origin', 42)
    ).rejects.toThrow('Remote "origin" is not configured.')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['fetch']),
      expect.anything()
    )
  })

  it('keeps WSL routing while bounding the pull-head fetch', async () => {
    await fetchGiteaPullRequestHeadRef({ path: '/repo', connectionId: null }, 'origin', 42, {
      localGitExecOptions: { cwd: '/repo', wslDistro: 'Ubuntu' }
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo',
      wslDistro: 'Ubuntu'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['fetch', '--no-tags', 'origin', `+refs/pull/42/head:${LOCAL_REF}`],
      { cwd: '/repo', wslDistro: 'Ubuntu', timeout: REVIEW_HEAD_FETCH_TIMEOUT_MS }
    )
  })

  it('rejects a Gitea pull-head fetch for an SSH repo', async () => {
    await expect(
      fetchGiteaPullRequestHeadRef({ path: '/repo', connectionId: 'conn-1' }, 'origin', 42)
    ).rejects.toThrow('SSH Git provider is not available')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('rejects invalid PR numbers and option-shaped remotes before running git', async () => {
    await expect(
      fetchGiteaPullRequestHeadRef({ path: '/repo', connectionId: null }, 'origin', 0)
    ).rejects.toThrow('Invalid pull request number')
    await expect(
      fetchGiteaPullRequestHeadRef({ path: '/repo', connectionId: null }, '-o', 42)
    ).rejects.toThrow('must not start with "-"')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
