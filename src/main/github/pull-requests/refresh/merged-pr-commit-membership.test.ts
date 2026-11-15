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
  getMergedPRHeadRelationship,
  resetMergedPRCommitMembershipCacheForTest
} from './merged-pr-commit-membership'

const REBASED_AWAY = '6ada46e391c5e4025d13d0304c4c0729af13a923'

function membership() {
  return getMergedPRHeadRelationship({
    ownerRepo: { owner: 'stablyai', repo: 'orca' },
    prNumber: 41082,
    commitOid: REBASED_AWAY,
    ghOptions: { cwd: '/repo' }
  })
}

function scriptForcePushes(beforeOids: (string | null)[], hasPreviousPage = false): void {
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[1] === 'graphql') {
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                timelineItems: {
                  totalCount: 23,
                  pageInfo: { hasPreviousPage },
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

describe('getMergedPRHeadRelationship', () => {
  it('proves absence from a complete filtered page despite an unfiltered total count', async () => {
    scriptForcePushes([
      '1111111111111111111111111111111111111111',
      '2222222222222222222222222222222222222222'
    ])
    await expect(membership()).resolves.toBe('not-contained')
  })

  it('keeps absence unknown when a previous filtered page exists', async () => {
    scriptForcePushes(['1111111111111111111111111111111111111111'], true)
    await expect(membership()).resolves.toBe('unknown')
  })

  it('preserves uncertainty when a force-push event has no prior commit', async () => {
    scriptForcePushes([null])
    await expect(membership()).resolves.toBe('unknown')
  })

  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    resetMergedPRCommitMembershipCacheForTest()
  })

  it('treats a force-pushed-away head as association without claiming its changes landed', async () => {
    scriptForcePushes([null, REBASED_AWAY])
    await expect(membership()).resolves.toBe('associated')
  })
})
