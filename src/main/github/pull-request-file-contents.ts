import type { GitHubPRFile, GitHubPRFileContents } from '../../shared/github/pull-request-types'
import { acquire, ghExecFileAsync, ghRepoExecOptions, githubRepoContext, release } from './gh-utils'
import type { LocalGitExecOptions } from './gh-utils'
import {
  githubHostExecOptions,
  resolveGitHubRepoExecution,
  type GitHubApiRepository
} from './github-api-repository'
import { isMaxBufferOverflowError } from '../git/max-buffer-overflow'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from './rate-limit'

const GITHUB_RAW_CONTENT_MAX_BUFFER_BYTES = 8 * 1024 * 1024

function encodeGitHubContentPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

async function fetchContentAtRef(args: {
  repoPath: string
  connectionId?: string | null
  localGitOptions?: LocalGitExecOptions
  ownerRepo: GitHubApiRepository
  path: string
  ref: string
}): Promise<{ content: string; isBinary: boolean; tooLarge?: boolean }> {
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(args.repoPath, args.connectionId, args.localGitOptions)),
    ...githubHostExecOptions(args.ownerRepo),
    maxBuffer: GITHUB_RAW_CONTENT_MAX_BUFFER_BYTES
  }
  if (repositoryRateLimitGuard(args.ownerRepo, 'core', ghOptions).blocked) {
    return { content: '', isBinary: false }
  }
  try {
    noteRepositoryRateLimitSpend(args.ownerRepo, 'core', 1, ghOptions)
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '--cache',
        '300s',
        '-H',
        'Accept: application/vnd.github.raw',
        `repos/${args.ownerRepo.owner}/${args.ownerRepo.repo}/contents/${encodeGitHubContentPath(args.path)}?ref=${encodeURIComponent(args.ref)}`
      ],
      ghOptions
    )
    const sample = stdout.slice(0, 2048)
    if (sample.includes('\u0000')) {
      return { content: '', isBinary: true }
    }
    return { content: stdout, isBinary: false }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return { content: '', isBinary: false, tooLarge: true }
    }
    return { content: '', isBinary: false }
  }
}

export async function getPRFileContents(args: {
  repoPath: string
  connectionId?: string | null
  localGitOptions?: LocalGitExecOptions
  prRepo?: GitHubApiRepository | null
  prNumber: number
  path: string
  oldPath?: string
  status: GitHubPRFile['status']
  headSha: string
  baseSha: string
}): Promise<GitHubPRFileContents> {
  const { ownerRepo } = await resolveGitHubRepoExecution(
    args.repoPath,
    args.prRepo,
    args.connectionId,
    args.localGitOptions
  )
  if (!ownerRepo) {
    return {
      original: '',
      modified: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
  }

  await acquire()
  try {
    // Added and removed files have no content on one side of the comparison.
    const needsOriginal = args.status !== 'added'
    const needsModified = args.status !== 'removed'
    const originalPath = args.oldPath ?? args.path
    const [original, modified] = await Promise.all([
      needsOriginal
        ? fetchContentAtRef({
            repoPath: args.repoPath,
            connectionId: args.connectionId,
            localGitOptions: args.localGitOptions,
            ownerRepo,
            path: originalPath,
            ref: args.baseSha
          })
        : Promise.resolve<{ content: string; isBinary: boolean; tooLarge?: boolean }>({
            content: '',
            isBinary: false
          }),
      needsModified
        ? fetchContentAtRef({
            repoPath: args.repoPath,
            connectionId: args.connectionId,
            localGitOptions: args.localGitOptions,
            ownerRepo,
            path: args.path,
            ref: args.headSha
          })
        : Promise.resolve<{ content: string; isBinary: boolean; tooLarge?: boolean }>({
            content: '',
            isBinary: false
          })
    ])
    return {
      original: original.content,
      modified: modified.content,
      originalIsBinary: original.isBinary,
      modifiedIsBinary: modified.isBinary,
      originalTooLarge: original.tooLarge,
      modifiedTooLarge: modified.tooLarge
    }
  } finally {
    release()
  }
}
