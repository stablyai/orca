import type { GhAccountBinding } from '../../../shared/github/accounts/account-binding'
import {
  withGitHubRepoExecution,
  type LocalGitExecOptions
} from '../repositories/github-repository-identity'
import type { PRCheckDetail } from '../../../shared/github/checks/check-types'

import type { GitHubWorkItemDetails } from '../../../shared/github/work-items/work-item-types'
import type { IssueSourcePreference } from '../../../shared/repo-types'
import { getPRChecks } from '../client/check/get-pr-checks'
import { getPRComments } from '../client/fetch/get-pr-comments'
import { getWorkItemWithRepository, getWorkItemByOwnerRepo } from '../client/fetch/get-work-item'
import { acquire, release } from '../execution/github-operation-slots'

import { resolveGitHubRepoExecution } from '../repositories/github-api-repository'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../shared/github/repositories/repository-identity'
import { isValidGitHubApiRepository } from '../repositories/github-api-repository-validation'
import {
  getIssueBodyAndComments,
  getIssueDetailsViaGraphQL
} from '../issues/issue-work-item-details'
import {
  getPRFiles,
  getPRMetadata,
  mergePRFileViewedStates
} from '../pull-requests/files/pull-request-file-data'
import { getPRDetailContext } from '../pull-requests/files/pull-request-detail-context'

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
  preference?: IssueSourcePreference,
  repositoryOverride?: unknown,
  // Only an explicit Refresh asks for uncached reads whose required parts fail instead of collapsing to empty.
  canonical = false,
  expectedGhAccount?: GhAccountBinding | null
): Promise<GitHubWorkItemDetails | null> {
  return withGitHubRepoExecution(
    repoPath,
    connectionId,
    localGitOptions,
    async () => {
      let repositoryTarget: GitHubApiRepository | null = null
      if (type && repositoryOverride != null) {
        if (!isValidGitHubApiRepository(repositoryOverride)) {
          return null
        }
        repositoryTarget = (
          await resolveGitHubRepoExecution(
            repoPath,
            repositoryOverride,
            connectionId,
            localGitOptions
          )
        ).ownerRepo
        if (!repositoryTarget) {
          return null
        }
      }
      const {
        item,
        repository: selectedRepository,
        issueDetails
      } = repositoryTarget
        ? {
            item: await getWorkItemByOwnerRepo(
              repoPath,
              repositoryTarget,
              number,
              type === 'pr' ? 'pr' : 'issue',
              connectionId,
              localGitOptions
            ),
            repository: repositoryTarget,
            issueDetails: undefined
          }
        : await getWorkItemWithRepository(
            repoPath,
            number,
            type,
            connectionId,
            localGitOptions,
            preference,
            type === 'issue' && !canonical
          )
      if (!item) {
        return null
      }

      // The clone selects execution; an addressed item selects every detail read.
      const resolvedRepository =
        repositoryTarget ??
        (item.type === 'issue'
          ? selectedRepository
          : (await resolveGitHubRepoExecution(repoPath, item.prRepo, connectionId, localGitOptions))
              .ownerRepo)

      if (item.type === 'issue') {
        return withWorkItemDetailsPermit(async () => {
          const collapsed =
            issueDetails === undefined
              ? await getIssueDetailsViaGraphQL(
                  repoPath,
                  item.number,
                  resolvedRepository,
                  connectionId,
                  localGitOptions,
                  false,
                  canonical
                )
              : issueDetails
          if (collapsed) {
            return {
              item: enrichItemDisplayAvatars(item, [
                ...collapsed.participants,
                ...collapsed.assigneeUsers
              ]),
              body: collapsed.body,
              bodyImageUrls: collapsed.bodyImageUrls,
              comments: collapsed.comments,
              assignees: item.assignees?.map((user) => user.login) ?? collapsed.assignees,
              participants: collapsed.participants,
              timelineItems: collapsed.timelineItems
            }
          }
          const [{ body, bodyImageUrls, comments, assignees, timelineItems }, participants] =
            await Promise.all([
              getIssueBodyAndComments(
                repoPath,
                item.number,
                resolvedRepository,
                connectionId,
                localGitOptions,
                canonical
              ),
              getWorkItemParticipants(
                repoPath,
                item,
                resolvedRepository,
                connectionId,
                localGitOptions
              )
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
            bodyImageUrls,
            comments,
            assignees: item.assignees?.map((user) => user.login) ?? assignees,
            participants: mentionParticipants,
            timelineItems
          }
        })
      }

      // Nested client reads own their semaphore permits, so they stay outside these permits.
      const [{ viewedStates, participants }, metadata, files, comments] = await Promise.all([
        withWorkItemDetailsPermit(() =>
          getPRDetailContext(
            repoPath,
            item.number,
            resolvedRepository,
            connectionId,
            localGitOptions
          )
        ),
        withWorkItemDetailsPermit(() =>
          getPRMetadata(repoPath, item.number, resolvedRepository, connectionId, localGitOptions)
        ),
        withWorkItemDetailsPermit(() =>
          getPRFiles(repoPath, item.number, resolvedRepository, connectionId, localGitOptions)
        ),
        resolvedRepository
          ? getPRComments(
              repoPath,
              item.number,
              // An explicit refresh must not join or reuse a read that started before it.
              { prRepo: resolvedRepository, noCache: canonical },
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
        bodyImageUrls: metadata.bodyImageUrls,
        comments,
        headSha: metadata.headSha,
        baseSha: metadata.baseSha,
        pullRequestId: viewedStates?.pullRequestId,
        checks,
        files: files === null ? undefined : mergePRFileViewedStates(files, viewedStates),
        filesUnavailable: files === null,
        participants: mentionParticipants
      }
    },
    expectedGhAccount
  )
}
