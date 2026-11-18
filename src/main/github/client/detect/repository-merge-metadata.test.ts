import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: exec
}))
vi.mock('../../api/rate-limit', () => ({
  noteRepositoryRateLimitSpend: vi.fn(),
  repositoryRateLimitGuard: () => ({ blocked: false })
}))

import { detectRepositoryMergeMetadata } from './repository-merge-metadata'
import { _resetMergeQueueCacheForTests } from './repository-merge-metadata-cache'

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const repositorySettings = {
  viewerDefaultMergeMethod: 'MERGE',
  mergeCommitAllowed: true,
  rebaseMergeAllowed: false,
  squashMergeAllowed: true,
  autoMergeAllowed: false,
  mergeQueue: null
}

describe('detectRepositoryMergeMetadata', () => {
  beforeEach(() => {
    exec.mockReset()
    _resetMergeQueueCacheForTests()
  })

  it('limits merge methods to what the base branch pull request rule allows', async () => {
    exec.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          repository: {
            ...repositorySettings,
            ref: {
              rules: {
                nodes: [
                  { type: 'DELETION', parameters: null },
                  { type: 'PULL_REQUEST', parameters: { allowedMergeMethods: ['SQUASH'] } }
                ]
              }
            }
          }
        }
      })
    })

    const metadata = await detectRepositoryMergeMetadata(repository, 'dev', {})

    expect(metadata.mergeMethodSettings).toEqual({
      defaultMethod: 'squash',
      allowedMethods: { squash: true, merge: false, rebase: false }
    })
  })

  it('keeps merge queue detection on hosts without ruleset merge methods', async () => {
    // Fakes an older GHES schema, in the error shape gh prints for an unknown field.
    exec.mockImplementation(async (args: string[]) => {
      if (args.some((arg) => arg.includes('allowedMergeMethods'))) {
        throw Object.assign(new Error('gh exited 1'), {
          stdout: JSON.stringify({
            errors: [
              {
                message: "Field 'allowedMergeMethods' doesn't exist on type 'PullRequestParameters'"
              }
            ]
          })
        })
      }
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              ...repositorySettings,
              ref: { rules: { nodes: [{ type: 'MERGE_QUEUE' }, { type: 'PULL_REQUEST' }] } }
            }
          }
        })
      }
    })

    const metadata = await detectRepositoryMergeMetadata(repository, 'dev', {})

    expect(metadata).toEqual({
      mergeQueueRequired: true,
      autoMergeAllowed: false,
      mergeMethodSettings: {
        defaultMethod: 'merge',
        allowedMethods: { squash: true, merge: true, rebase: false }
      }
    })
  })
})
