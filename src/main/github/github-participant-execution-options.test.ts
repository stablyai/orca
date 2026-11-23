import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ghRepoExecOptions,
  githubRepoContext,
  withGitHubRepoExecution
} from './repositories/github-repository-identity'
import { resolveHostedReviewGitHubOptions } from '../source-control/hosted-review-git-options'
import { installGitHubProjectAccounts } from './accounts/github-project-account'
import { GitHubParticipantRegistry } from '../runtime/github-participant-registry'
import { createGitHubExecutionAccountResolver } from '../runtime/github-participant-execution'
import { runWithActiveRpcCaller } from '../runtime/rpc/callers/active-call'
import type { Repo } from '../../shared/repository/repo-types'

describe('GitHub participant execution options', () => {
  it('keeps participant accounts and grant checks across automatic project and nested repo scopes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-member-project-account-'))
    const account = { host: 'github.com', user: 'alice' }
    const repo: Repo = {
      id: 'repo',
      path: directory,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 0,
      ghAccount: { host: 'github.com', user: 'owner' }
    }
    const release = installGitHubProjectAccounts({ getRepos: () => [repo] })
    try {
      const registry = new GitHubParticipantRegistry(directory, () => ({}))
      await registry.ready()
      const member = await registry.createParticipant({
        name: 'Alice',
        deviceIds: ['device'],
        allowedAccounts: [account]
      })
      await registry.setRepoEnabled(repo.id, true)
      await registry.selectAccount(repo.id, 'device', account)
      const resolveGitHubAccount = runWithActiveRpcCaller(
        { kind: 'paired-device', deviceId: 'device' },
        () => createGitHubExecutionAccountResolver(registry, repo.id, repo.ghAccount)
      )
      const options = resolveHostedReviewGitHubOptions({
        localGitExecOptions: { resolveGitHubAccount }
      })
      await withGitHubRepoExecution(repo.path, null, options, async () => {
        await Promise.resolve()
        const nested = ghRepoExecOptions(githubRepoContext(repo.path))
        expect(nested.ghAccount).toEqual(account)
        expect(nested.canStart?.()).toBe(true)
        await registry.updateParticipant(member.id, { allowedAccounts: [] })
        expect(() => nested.canStart?.()).toThrow('github_participant_account_not_allowed')
      })
    } finally {
      release()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
