import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ghRepoExecOptions,
  githubRepoContext,
  withGitHubRepoExecution
} from './github-repository-identity'
import {
  getHostedReviewLocalGitOptions,
  resolveHostedReviewGitHubOptions
} from '../source-control/hosted-review-git-options'
import { installGitHubProjectAccounts } from './github-project-account'
import { GitHubParticipantRegistry } from '../runtime/github-participant-registry'
import { createGitHubExecutionAccountResolver } from '../runtime/github-participant-execution'
import { runWithActiveRpcCaller } from '../runtime/rpc/rpc-active-caller'
import { storeRepo } from '../runtime/runtime-store-partial-fixture'

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

  it('keeps participant accounts and grant checks across automatic project and nested repo scopes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-member-project-account-'))
    const account = { host: 'github.com', user: 'alice' }
    const repo = storeRepo({
      id: 'repo',
      path: directory,
      ghAccount: { host: 'github.com', user: 'owner' }
    })
    const release = installGitHubProjectAccounts({ getRepos: () => [repo] })
    try {
      const registry = new GitHubParticipantRegistry(directory, () => ({}))
      const member = registry.createParticipant({
        name: 'Alice',
        deviceIds: ['device'],
        allowedAccounts: [account]
      })
      registry.setRepoEnabled(repo.id, true)
      registry.selectAccount(repo.id, 'device', account)
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
        registry.updateParticipant(member.id, { allowedAccounts: [] })
        expect(() => nested.canStart?.()).toThrow('github_participant_account_not_allowed')
      })
    } finally {
      release()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
