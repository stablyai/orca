import type { PRCheckDetail } from '../../shared/github/check-types'
import type { GitHubPRFile, GitHubPRFileContents } from '../../shared/github/pull-request-types'
import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../shared/github/work-item-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { getPRChecks, getPRComments, getWorkItem } from './client'
import { acquire, release, type LocalGitExecOptions } from './gh-utils'
import {
  getIssueGitHubApiRepository,
  resolveGitHubRepoExecution,
  type GitHubApiRepository
} from './github-api-repository'
import { getIssueBodyAndComments, getIssueDetailsViaGraphQL } from './issue-work-item-details'
import {
  getPRFiles,
  getPRFileViewedStates,
  getPRMetadata,
  mergePRFileViewedStates
} from './pull-request-file-data'
import { getPRFileContents as loadPRFileContents } from './pull-request-file-contents'
import {
  enrichItemDisplayAvatars,
  getMentionParticipants,
  getWorkItemParticipants
} from './work-item-participants'

function localGitOptionArgs(options: LocalGitExecOptions = {}): [] | [LocalGitExecOptions] {
  return Object.keys(options).length > 0 ? [options] : []
}

async function withWorkItemDetailsPermit<T>(operation: () => Promise<T>): Promise<T> {
  await acquire()
  try {
    return await operation()
  } finally {
    release()
  }
}

async function getPRChecksForDetails(
  repoPath: string,
  prNumber: number,
  headSha: string | undefined,
  repository: GitHubApiRepository | null,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRCheckDetail[]> {
  if (!repository) {
    return []
  }
  try {
    return await getPRChecks(
      repoPath,
      prNumber,
      headSha,
      repository,
      undefined,
      connectionId,
      ...localGitOptionArgs(localGitOptions)
    )
  } catch (error) {
    console.warn('getWorkItemDetails PR checks failed:', error)
    return []
  }
}

export async function getWorkItemDetails(
  repoPath: string,
  number: number,
  type?: 'issue' | 'pr',
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  preference?: IssueSourcePreference
): Promise<GitHubWorkItemDetails | null> {
  const item: Omit<GitHubWorkItem, 'repoId'> | null = await getWorkItem(
    repoPath,
    number,
    type,
    connectionId,
    localGitOptions,
    preference
  )
  if (!item) {
    return null
  }

  const resolvedRepository =
    item.type === 'issue'
      ? await getIssueGitHubApiRepository(repoPath, connectionId, localGitOptions)
      : (await resolveGitHubRepoExecution(repoPath, item.prRepo, connectionId, localGitOptions))
          .ownerRepo

  if (item.type === 'issue') {
    return withWorkItemDetailsPermit(async () => {
      const collapsed = await getIssueDetailsViaGraphQL(
        repoPath,
        item.number,
        resolvedRepository,
        connectionId,
        localGitOptions
      )
      if (collapsed) {
        return {
          item: enrichItemDisplayAvatars(item, [
            ...collapsed.participants,
            ...collapsed.assigneeUsers
          ]),
          body: collapsed.body,
          comments: collapsed.comments,
          assignees: collapsed.assignees,
          participants: collapsed.participants,
          timelineItems: collapsed.timelineItems
        }
      }
      const [{ body, comments, assignees, timelineItems }, participants] = await Promise.all([
        getIssueBodyAndComments(
          repoPath,
          item.number,
          resolvedRepository,
          connectionId,
          localGitOptions
        ),
        getWorkItemParticipants(repoPath, item, resolvedRepository, connectionId, localGitOptions)
      ])
      const mentionParticipants = await getMentionParticipants(
        repoPath,
        item,
        comments,
        participants,
        resolvedRepository,
        connectionId,
        localGitOptions
      )
      return {
        item: enrichItemDisplayAvatars(item, mentionParticipants),
        body,
        comments,
        assignees,
        participants: mentionParticipants,
        timelineItems
      }
    })
  }

  // Nested client reads own their semaphore permits, so they stay outside these permits.
  const [[metadata, files, viewedStates, participants], comments] = await Promise.all([
    Promise.all([
      withWorkItemDetailsPermit(() =>
        getPRMetadata(repoPath, item.number, resolvedRepository, connectionId, localGitOptions)
      ),
      withWorkItemDetailsPermit(() =>
        getPRFiles(repoPath, item.number, resolvedRepository, connectionId, localGitOptions)
      ),
      withWorkItemDetailsPermit(() =>
        getPRFileViewedStates(
          repoPath,
          item.number,
          resolvedRepository,
          connectionId,
          localGitOptions
        )
      ),
      withWorkItemDetailsPermit(() =>
        getWorkItemParticipants(repoPath, item, resolvedRepository, connectionId, localGitOptions)
      )
    ]),
    resolvedRepository
      ? getPRComments(
          repoPath,
          item.number,
          { prRepo: resolvedRepository },
          connectionId,
          ...localGitOptionArgs(localGitOptions)
        )
      : Promise.resolve([])
  ])

  const [mentionParticipants, checks] = await Promise.all([
    withWorkItemDetailsPermit(() =>
      getMentionParticipants(
        repoPath,
        item,
        comments,
        participants,
        resolvedRepository,
        connectionId,
        localGitOptions
      )
    ),
    getPRChecksForDetails(
      repoPath,
      item.number,
      metadata.headSha,
      resolvedRepository,
      connectionId,
      localGitOptions
    )
  ])

  return {
    item: enrichItemDisplayAvatars(
      resolvedRepository ? { ...item, prRepo: resolvedRepository } : item,
      mentionParticipants
    ),
    body: metadata.body,
    comments,
    headSha: metadata.headSha,
    baseSha: metadata.baseSha,
    pullRequestId: viewedStates?.pullRequestId,
    checks,
    files: files === null ? undefined : mergePRFileViewedStates(files, viewedStates),
    filesUnavailable: files === null,
    participants: mentionParticipants
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
  return loadPRFileContents(args)
}
