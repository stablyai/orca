import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult
} from '../../shared/source-control/hosted-review/hosted-review-contracts'
import { normalizeHostedReviewBaseRef } from '../../shared/source-control/hosted-review/hosted-review-refs'
import type { ExecutionHostId } from '../../shared/execution-host/execution-host'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { hostedReviewSshConnectionId } from '../source-control/hosted-review-execution-host'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import { execNgit, type NgitExec } from './ngit-cli'
import { getPrimaryNostrRepoRef } from './repository-ref'
import { forgetNostrRepositorySnapshots, getNostrRepositorySnapshot } from './repository-snapshot'
import { findPullRequestForBranch } from './pull-request-lookup'

function failed(error: string, code: 'validation' | 'unknown' = 'validation') {
  return { ok: false as const, code, error }
}

export async function createNgitPullRequest(
  repoPath: string,
  input: CreateHostedReviewInput,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {},
  exec: NgitExec = execNgit
): Promise<CreateHostedReviewResult> {
  // `ngit send` reads the commits and signs, so both must live on this machine.
  if (hostedReviewSshConnectionId(executionHostId)) {
    return failed(
      'Create PR failed: ngit pull requests cannot be opened from SSH repositories yet.'
    )
  }
  const localGit = getHostedReviewLocalGitOptions(options)
  const cwd = input.worktreePath ?? repoPath
  const title = input.title.trim()
  const git = async (args: string[]): Promise<string> =>
    (await gitExecFileAsync(args, { cwd, ...localGit })).stdout.trim()
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const ref = await getPrimaryNostrRepoRef(repoPath, null, localGit, branch)
  if (!ref) {
    return failed('Create PR failed: this branch does not push to a nostr remote.')
  }
  const base = normalizeHostedReviewBaseRef(input.base).replace(`${ref.remoteName}/`, '')
  if (!base || !title) {
    return failed('Create PR failed: choose a base branch and enter a title.')
  }
  try {
    const headOid = await git(['rev-parse', 'HEAD'])
    const stdout = await exec(
      [
        '--repo',
        ref.remoteName,
        'send',
        '--defaults',
        '--force-pr',
        `--base=${ref.remoteName}/${base}`,
        `--target-branch=${base}`,
        `--subject=${title}`,
        `--description=${input.body?.trim() || title}`,
        '--json'
      ],
      cwd
    )
    forgetNostrRepositorySnapshots()
    const snapshot = await getNostrRepositorySnapshot(ref, { force: true })
    const created = findPullRequestForBranch(snapshot?.items ?? [], branch, { headOid })
    if (!created || created.item.headSha !== headOid) {
      console.warn('ngit send finished without a visible pull request:', stdout.slice(-500))
      return {
        ok: false,
        code: 'unknown_completion',
        error: 'ngit sent the pull request, but no relay shows it yet. Refresh before retrying.'
      }
    }
    if (input.draft) {
      await exec(
        ['--repo', ref.remoteName, 'pr', 'draft', created.item.eventId, '--json'],
        cwd
      ).catch((error) => console.warn('Could not mark the ngit pull request as draft:', error))
      forgetNostrRepositorySnapshots()
    }
    return { ok: true, number: created.item.number, url: created.item.url }
  } catch (error) {
    return failed(
      `Create PR failed: ${error instanceof Error ? error.message : String(error)}`,
      'unknown'
    )
  }
}
