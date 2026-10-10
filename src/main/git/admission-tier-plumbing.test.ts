import { describe, expect, it } from 'vitest'
import { hostedReviewOptionArgs } from '../github/pr-refresh-candidate-policy'
import { getHostedReviewLocalGitOptions } from '../source-control/hosted-review-git-options'
import { gitOptionsForWorktree, gitReadOptionsForWorktree } from './git-runtime-options'

describe('git admission tier plumbing', () => {
  it('preserves tiers through both runtime option constructors', () => {
    expect(
      gitOptionsForWorktree('/repo', { wslDistro: 'Ubuntu', admissionTier: 'interactive' })
    ).toEqual({ cwd: '/repo', wslDistro: 'Ubuntu', admissionTier: 'interactive' })
    expect(
      gitReadOptionsForWorktree('/repo', { wslDistro: 'Ubuntu', admissionTier: 'background' })
    ).toEqual({
      cwd: '/repo',
      wslDistro: 'Ubuntu',
      admissionTier: 'background',
      preferWslDirectGit: true
    })
  })

  it('preserves the hosted-review execution tier beside WSL routing', () => {
    expect(
      getHostedReviewLocalGitOptions({
        localGitExecOptions: { wslDistro: 'Ubuntu', admissionTier: 'interactive' }
      })
    ).toEqual({ wslDistro: 'Ubuntu', admissionTier: 'interactive' })
  })

  it.each([
    ['manual', 'interactive'],
    ['visible', 'background'],
    ['active', 'background'],
    ['post-push', 'background'],
    ['swr', 'background']
  ] as const)('maps PR refresh reason %s to %s admission', (reason, admissionTier) => {
    const [options] = hostedReviewOptionArgs(
      {
        localGitOptions: { wslDistro: 'Ubuntu' },
        linkedPRNumber: null,
        fallbackPRNumber: null,
        fallbackPRSource: null,
        currentHeadOid: null
      },
      reason
    )
    expect(options?.localGitExecOptions).toEqual({ wslDistro: 'Ubuntu', admissionTier })
  })
})
