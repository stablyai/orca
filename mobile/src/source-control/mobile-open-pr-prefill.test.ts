import { describe, expect, it, vi } from 'vitest'
import { getMobilePrEligibilityReadiness, readFreshGitStatus } from './mobile-open-pr-prefill'
import type { MobileGitStatusResult } from './mobile-git-status'

const fallback = { branch: 'old', entries: [] } as unknown as MobileGitStatusResult

describe('readFreshGitStatus', () => {
  it('returns the freshly-read status when parseable', async () => {
    const fresh = {
      branch: 'feat',
      head: 'sha',
      entries: [],
      upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0 }
    }
    const send = vi.fn(async () => fresh)
    const out = await readFreshGitStatus('w', fallback, send as never)
    expect(out?.branch).toBe('feat')
    expect(out?.upstreamStatus).toEqual({ hasUpstream: true, ahead: 1, behind: 0 })
    expect(send).toHaveBeenCalledWith('git.status', { worktree: 'id:w' })
  })

  it('falls back to the captured status when the read is unparseable', async () => {
    const send = vi.fn(async () => null)
    const out = await readFreshGitStatus('w', fallback, send as never)
    expect(out).toBe(fallback)
  })

  it('falls back to the captured status when the read rejects', async () => {
    const send = vi.fn(async () => {
      throw new Error('transport closed')
    })
    const out = await readFreshGitStatus('w', fallback, send as never)
    expect(out).toBe(fallback)
  })
})

describe('getMobilePrEligibilityReadiness', () => {
  it('keeps readiness fields absent when git status is unknown', () => {
    expect(getMobilePrEligibilityReadiness(null)).toEqual({})
  })

  it('derives dirty and upstream readiness from git status', () => {
    const status = {
      entries: [{ path: 'a.ts' }],
      upstreamStatus: { hasUpstream: true, ahead: 2, behind: 1 }
    } as unknown as MobileGitStatusResult

    expect(getMobilePrEligibilityReadiness(status)).toEqual({
      hasUncommittedChanges: true,
      hasUpstream: true,
      ahead: 2,
      behind: 1
    })
  })
})
