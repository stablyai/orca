import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { ghRepoExecOptions, githubRepoContext } from '../../repositories/github-repository-identity'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../../../source-control/hosted-review-git-options'
import { githubHostExecOptions } from '../../repositories/github-repository-host'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
export async function findOpenPRByHeadBase(args: {
  repoPath: string
  repo: GitHubApiRepository
  head: string
  base: string
  connectionId?: string | null
  options?: HostedReviewExecutionOptions
}): Promise<{ number: number; url: string } | null> {
  const localGitOptions = getHostedReviewLocalGitOptions(args.options)
  const context = githubRepoContext(args.repoPath, args.connectionId, localGitOptions)
  const { stdout } = await ghExecFileAsync(
    [
      'pr',
      'list',
      '--repo',
      `${args.repo.owner}/${args.repo.repo}`,
      '--head',
      args.head,
      '--base',
      args.base,
      '--state',
      'open',
      '--limit',
      '2',
      '--json',
      'number,url'
    ],
    {
      ...ghRepoExecOptions(context),
      ...githubHostExecOptions(args.repo)
    }
  )
  const list = JSON.parse(stdout) as { number?: number; url?: string }[]
  if (list.length !== 1 || !list[0]?.number || !list[0]?.url) {
    return null
  }
  return { number: list[0].number, url: list[0].url }
}

export async function readPullRequestTemplate(
  repoPath: string,
  connectionId?: string | null
): Promise<string> {
  const relativeCandidates = [
    '.github/pull_request_template.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'pull_request_template.md',
    'PULL_REQUEST_TEMPLATE.md',
    'docs/pull_request_template.md',
    'docs/PULL_REQUEST_TEMPLATE.md'
  ]
  if (connectionId) {
    return ''
  }
  for (const relativeCandidate of relativeCandidates) {
    try {
      return await readFile(join(repoPath, relativeCandidate), 'utf8')
    } catch {
      // Try the next conventional PR template path.
    }
  }
  return ''
}
