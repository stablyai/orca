import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getSshFilesystemProvider } from '../../../providers/ssh-filesystem-dispatch'
import { joinWorktreeRelativePath } from '../../../runtime/runtime-relative-paths'
import { ghExecFileAsync, ghRepoExecOptions, githubRepoContext } from '../../gh-utils'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../../../source-control/hosted-review-git-options'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
export async function findOpenPRByHeadBase(args: {
  repoPath: string
  repo: GitHubApiRepository
  head: string
  base: string
  connectionId?: string | null
  options?: HostedReviewExecutionOptions
}): Promise<{ number: number; url: string } | null> {
  const context = githubRepoContext(args.repoPath, args.connectionId)
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
      ...(args.connectionId ? {} : getHostedReviewLocalGitOptions(args.options)),
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
  const remoteProvider = connectionId ? getSshFilesystemProvider(connectionId) : undefined
  if (connectionId && !remoteProvider) {
    return ''
  }
  for (const relativeCandidate of relativeCandidates) {
    try {
      if (remoteProvider) {
        const result = await remoteProvider.readFile(
          joinWorktreeRelativePath(repoPath, relativeCandidate)
        )
        if (result.isBinary) {
          continue
        }
        return result.content
      }
      return await readFile(join(repoPath, relativeCandidate), 'utf8')
    } catch {
      // Try the next conventional PR template path.
    }
  }
  return ''
}
