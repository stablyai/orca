import type { GitHubPRFile } from '../../shared/github/pull-request-types'
import type { PRFileViewedStatesResult } from './pull-request-detail-context'
import { ghExecFileAsync, ghRepoExecOptions, githubRepoContext } from './gh-utils'
import type { LocalGitExecOptions } from './gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from './github-api-repository'
import { getPRReviewCommentLineNumbersFromPatch } from './pr-review-comment-lines'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from './rate-limit'

const MAX_PR_FILES = 300

type RESTPRFile = {
  filename: string
  previous_filename?: string
  status: string
  additions: number
  deletions: number
  changes: number
  patch?: string
}

function mapFileStatus(raw: string): GitHubPRFile['status'] {
  switch (raw) {
    case 'added':
      return 'added'
    case 'removed':
      return 'removed'
    case 'modified':
      return 'modified'
    case 'renamed':
      return 'renamed'
    case 'copied':
      return 'copied'
    case 'changed':
      return 'changed'
    case 'unchanged':
      return 'unchanged'
    default:
      return 'modified'
  }
}

function isBinaryHint(file: RESTPRFile): boolean {
  return file.patch === undefined && file.changes > 0
}

export async function getPRMetadata(
  repoPath: string,
  prNumber: number,
  repository: GitHubApiRepository | null,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ body: string; headSha?: string; baseSha?: string }> {
  if (!repository) {
    return { body: '' }
  }
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(repository)
  }
  if (repositoryRateLimitGuard(repository, 'core', ghOptions).blocked) {
    return { body: '' }
  }
  try {
    noteRepositoryRateLimitSpend(repository, 'core', 1, ghOptions)
    const { stdout } = await ghExecFileAsync(
      ['api', '--cache', '60s', `repos/${repository.owner}/${repository.repo}/pulls/${prNumber}`],
      ghOptions
    )
    const data = JSON.parse(stdout) as {
      body?: string | null
      head?: { sha?: string }
      base?: { sha?: string }
    }
    return {
      body: data.body ?? '',
      ...(data.head?.sha ? { headSha: data.head.sha } : {}),
      ...(data.base?.sha ? { baseSha: data.base.sha } : {})
    }
  } catch {
    return { body: '' }
  }
}

// null means unavailable; [] means a successfully fetched empty PR.
export async function getPRFiles(
  repoPath: string,
  prNumber: number,
  repository: GitHubApiRepository | null,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubPRFile[] | null> {
  if (!repository) {
    return null
  }
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(repository)
  }
  try {
    const data: RESTPRFile[] = []
    for (let page = 1; data.length < MAX_PR_FILES; page += 1) {
      if (repositoryRateLimitGuard(repository, 'core', ghOptions).blocked) {
        return null
      }
      const pageSuffix = page === 1 ? '' : `&page=${page}`
      noteRepositoryRateLimitSpend(repository, 'core', 1, ghOptions)
      const { stdout } = await ghExecFileAsync(
        [
          'api',
          '--cache',
          '60s',
          `repos/${repository.owner}/${repository.repo}/pulls/${prNumber}/files?per_page=100${pageSuffix}`
        ],
        ghOptions
      )
      const pageData = JSON.parse(stdout) as RESTPRFile[]
      data.push(...pageData.slice(0, MAX_PR_FILES - data.length))
      if (pageData.length < 100) {
        break
      }
    }
    return data.map((file) => ({
      path: file.filename,
      oldPath: file.previous_filename,
      status: mapFileStatus(file.status),
      additions: file.additions,
      deletions: file.deletions,
      isBinary: isBinaryHint(file),
      reviewCommentLineNumbers: getPRReviewCommentLineNumbersFromPatch(file.patch)
    }))
  } catch {
    return null
  }
}

export function mergePRFileViewedStates(
  files: GitHubPRFile[],
  viewedStates: PRFileViewedStatesResult | null
): GitHubPRFile[] {
  if (!viewedStates) {
    return files
  }
  return files.map((file) => ({
    ...file,
    viewerViewedState: viewedStates.viewedStates.get(file.path) ?? 'UNVIEWED'
  }))
}
