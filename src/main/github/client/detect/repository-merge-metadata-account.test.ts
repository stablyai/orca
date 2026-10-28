import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detectRepositoryMergeMetadata } from './repository-merge-metadata'
import { repositoryMergeMetadataCache } from './repository-merge-metadata-cache'
import { githubPRStackExecutionScope } from '../github-exec-scope'

const { ghExecFileAsync } = vi.hoisted(() => ({ ghExecFileAsync: vi.fn() }))
vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', () => ({ ghExecFileAsync }))
vi.mock('../../api/rate-limit', () => ({
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: vi.fn()
}))

beforeEach(() => {
  repositoryMergeMetadataCache.clear()
  ghExecFileAsync.mockReset()
})

describe('participant merge preferences', () => {
  it.each(['explicit', 'default'] as const)(
    'keeps concurrent viewer defaults separate with %s scope',
    async (scopeMode) => {
      ghExecFileAsync.mockImplementation(async (_args, options) => ({
        stdout: JSON.stringify({
          data: {
            repository: {
              viewerDefaultMergeMethod: options.ghAccount.user === 'alice' ? 'REBASE' : 'SQUASH',
              mergeCommitAllowed: true,
              rebaseMergeAllowed: true,
              squashMergeAllowed: true,
              autoMergeAllowed: true
            }
          }
        })
      }))
      const read = (user: string) => {
        const ghAccount = { host: 'github.com', user }
        const scope =
          scopeMode === 'explicit'
            ? githubPRStackExecutionScope(null, { resolveGitHubAccount: () => ghAccount })
            : undefined
        return detectRepositoryMergeMetadata(
          { owner: 'team', repo: 'orca', host: 'github.com' },
          'main',
          { cwd: '/repo', ghAccount },
          scope
        )
      }
      await Promise.all([read('alice'), read('bob')])
      expect((await read('alice')).mergeMethodSettings?.defaultMethod).toBe('rebase')
      expect((await read('bob')).mergeMethodSettings?.defaultMethod).toBe('squash')
      expect(ghExecFileAsync).toHaveBeenCalledTimes(2)
    }
  )
})
