import { describe, expect, it, vi } from 'vitest'
import { loadMobilePrBranchContext } from './use-mobile-pr-branch-context'

describe('loadMobilePrBranchContext', () => {
  it('keeps status and repo eligibility when branchCompare fails', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'git.status') {
        return {
          ok: true,
          result: { entries: [], conflictOperation: 'unknown', branch: 'feat', head: 'sha-status' }
        }
      }
      if (method === 'repo.list') {
        return {
          ok: true,
          result: { repos: [{ id: 'repo', worktreeBaseRef: 'main' }] }
        }
      }
      if (method === 'git.branchCompare') {
        return { ok: false, error: { message: 'compare failed' } }
      }
      if (method === 'github.repoSlug') {
        return { ok: true, result: { owner: 'stablyai', repo: 'orca' } }
      }
      return { ok: false, error: { message: `unexpected ${method}` } }
    })
    const out = await loadMobilePrBranchContext({ sendRequest } as never, 'repo::/wt')
    expect(sendRequest).toHaveBeenCalledWith('git.branchCompare', {
      worktree: 'id:repo::/wt',
      baseRef: 'main'
    })
    expect(out).toEqual({
      branch: 'feat',
      headSha: 'sha-status',
      status: expect.objectContaining({ branch: 'feat', head: 'sha-status' }),
      isGithubRepo: true,
      repoLoaded: true,
      loaded: true
    })
  })
})
