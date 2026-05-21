import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { getUpstreamStatus } from './upstream'

const missingTrackingRefError = new Error(
  "fatal: ambiguous argument 'HEAD@{u}': unknown revision or path not in the working tree.\n" +
    "Use '--' to separate paths from revisions, like this:\n" +
    "'git <command> [<revision>...] -- [<file>...]'"
)

describe('getUpstreamStatus', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('returns upstream and ahead/behind counts when tracking is configured', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n' })
      .mockResolvedValueOnce({ stdout: 'origin/main\n' })
      .mockResolvedValueOnce({ stdout: '2\t3\n' })
      .mockResolvedValueOnce({ stdout: '+ abc123 remote work\n' })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 3,
      behindCommitsArePatchEquivalent: false
    })
  })

  it('marks diverged upstream commits as patch-equivalent after a rebase', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n' })
      .mockResolvedValueOnce({ stdout: '14\t3\n' })
      .mockResolvedValueOnce({
        stdout:
          '= ac503deae Stabilize pull request creation flow\n' +
          '= 7dc0fc1a6 Clean up fork PR remotes after worktree deletion\n'
      })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 14,
      behind: 3,
      behindCommitsArePatchEquivalent: true
    })
  })

  it('keeps configured local-branch upstreams', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockResolvedValueOnce({ stdout: 'main\n' })
      .mockResolvedValueOnce({ stdout: '1\t0\n' })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'main',
      ahead: 1,
      behind: 0
    })
  })

  it('returns hasUpstream=false when upstream output is empty', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockResolvedValueOnce({ stdout: '\n' })
      .mockRejectedValueOnce(new Error('missing remote branch'))

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('returns hasUpstream=false when upstream is missing', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockRejectedValueOnce(new Error('fatal: no upstream configured'))
      .mockRejectedValueOnce(new Error('missing remote branch'))

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('returns hasUpstream=false when the configured tracking ref is missing', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockRejectedValueOnce(missingTrackingRefError)
      .mockRejectedValueOnce(new Error('missing remote branch'))

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('uses the same-name origin branch when a legacy worktree tracks origin/main', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockResolvedValueOnce({ stdout: 'origin/main\n' })
      .mockResolvedValueOnce({ stdout: 'abc123\n' })
      .mockResolvedValueOnce({ stdout: '3\t1\n' })
      .mockResolvedValueOnce({ stdout: '+ def456 remote work\n' })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 3,
      behind: 1,
      behindCommitsArePatchEquivalent: false
    })
  })
})
