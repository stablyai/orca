import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock } = vi.hoisted(() => ({ ghExecFileAsyncMock: vi.fn() }))

vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))
vi.mock('../../api/rate-limit', () => ({
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: () => {}
}))

import {
  isCommitPartOfMergedPR,
  resetMergedPRCommitMembershipCacheForTest
} from './merged-pr-commit-membership'

const REBASED_AWAY = '6ada46e391c5e4025d13d0304c4c0729af13a923'

function membership() {
  return isCommitPartOfMergedPR({
    ownerRepo: { owner: 'stablyai', repo: 'orca' },
    prNumber: 41082,
    commitOid: REBASED_AWAY,
    ghOptions: { cwd: '/repo' }
  })
}

function scriptForcePushes(beforeOids: (string | null)[]): void {
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[1] === 'graphql') {
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                timelineItems: {
                  totalCount: beforeOids.length,
                  nodes: beforeOids.map((oid) => ({ beforeCommit: oid ? { oid } : null }))
                }
              }
            }
          }
        })
      }
    }
    // GitHub drops a force-pushed-away commit's PR association.
    return { stdout: '[]' }
  })
}

describe('isCommitPartOfMergedPR', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    resetMergedPRCommitMembershipCacheForTest()
  })

  it('counts a head the PR was force-pushed away from, as after a rebase pushed elsewhere', async () => {
    scriptForcePushes([null, REBASED_AWAY])
    await expect(membership()).resolves.toBe('contained')
  })
})
