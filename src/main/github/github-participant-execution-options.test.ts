import { describe, expect, it, vi } from 'vitest'
import { ghRepoExecOptions, githubRepoContext } from './github-repository-identity'
import { getHostedReviewLocalGitOptions } from '../source-control/hosted-review-git-options'

describe('GitHub participant execution options', () => {
  it('preserves the explicit resolver through generic Git options and resolves at the GitHub gateway', () => {
    const selected = { host: 'github.com', user: 'alice' }
    const resolveGitHubAccount = vi.fn(() => selected)
    const local = getHostedReviewLocalGitOptions({
      localGitExecOptions: {
        ghAccount: { host: 'github.com', user: 'owner' },
        resolveGitHubAccount
      }
    })
    const context = githubRepoContext('/repo', null, local)
    expect(resolveGitHubAccount).not.toHaveBeenCalled()
    expect(ghRepoExecOptions(context).ghAccount).toEqual(selected)
    expect(resolveGitHubAccount).toHaveBeenCalledOnce()
  })
})
