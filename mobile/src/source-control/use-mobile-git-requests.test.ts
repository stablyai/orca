import { describe, expect, it, vi } from 'vitest'
import { runMobileGitSyncSteps } from './use-mobile-git-requests'

function hostReplying(replies: Record<string, unknown>) {
  return vi.fn(async (method: string) => {
    const reply = replies[method]
    if (reply instanceof Error) {
      throw reply
    }
    return reply
  })
}

const unavailable = Object.assign(new Error('not available'), { code: 'method_not_found' })

describe('runMobileGitSyncSteps', () => {
  it('pushes when the host reports commits ahead', async () => {
    const send = hostReplying({ 'git.upstreamStatus': { hasUpstream: true, ahead: 2, behind: 0 } })
    await runMobileGitSyncSteps(send)
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'git.fetch',
      'git.pull',
      'git.upstreamStatus',
      'git.push'
    ])
  })

  it('does not push when nothing is ahead', async () => {
    const send = hostReplying({ 'git.upstreamStatus': { hasUpstream: true, ahead: 0, behind: 0 } })
    await runMobileGitSyncSteps(send)
    expect(send).not.toHaveBeenCalledWith('git.push')
  })

  it.each([
    ['missing ahead', { hasUpstream: true, behind: 0 }],
    ['non-numeric ahead', { hasUpstream: true, ahead: '2', behind: 0 }],
    ['no reply', undefined]
  ])('fails instead of silently skipping the push on %s', async (_label, reply) => {
    const send = hostReplying({ 'git.upstreamStatus': reply })
    await expect(runMobileGitSyncSteps(send)).rejects.toThrow('Branch status unavailable')
    expect(send).not.toHaveBeenCalledWith('git.push')
  })

  it('falls back to git.status on hosts without git.upstreamStatus', async () => {
    const send = hostReplying({
      'git.upstreamStatus': unavailable,
      'git.status': { entries: [], upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 } }
    })
    await runMobileGitSyncSteps(send)
    expect(send).toHaveBeenCalledWith('git.push')
  })

  it('fails when the git.status fallback has an unreadable upstream', async () => {
    const send = hostReplying({
      'git.upstreamStatus': unavailable,
      'git.status': { entries: [], upstreamStatus: { hasUpstream: true, behind: 0 } }
    })
    await expect(runMobileGitSyncSteps(send)).rejects.toThrow('Branch status unavailable')
    expect(send).not.toHaveBeenCalledWith('git.push')
  })
})
