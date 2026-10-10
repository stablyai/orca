import { ipcMain } from 'electron'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { Store } from '../persistence'
import {
  normalizeGitLabMRListState,
  normalizeGitLabPositiveInteger,
  normalizeGitLabSearchQuery
} from '../gitlab/gitlab-preload-args'
import { getMergeRequest, getMergeRequestForBranch, listMergeRequests } from '../gitlab/client'
import type { GitLabRepoSelectorArgs } from './gitlab-repo-access'
import {
  assertRegisteredRepo,
  hostedReviewOptionArgs,
  localGitOptionArgs,
  repoConnectionId
} from './gitlab-repo-access'

export function registerGitLabMergeRequestQueryHandlers(store: Store): void {
  ipcMain.handle(
    'gitlab:mrForBranch',
    async (
      _event,
      args: GitLabRepoSelectorArgs & { branch: string; linkedMRIid?: number | null }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return getMergeRequestForBranch(
        repo.path,
        args.branch,
        args.linkedMRIid ?? null,
        repoConnectionId(repo),
        ...hostedReviewOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle('gitlab:mr', async (_event, args: GitLabRepoSelectorArgs & { iid: number }) => {
    const repo = assertRegisteredRepo(args, store)
    return getMergeRequest(
      repo.path,
      args.iid,
      repoConnectionId(repo),
      ...hostedReviewOptionArgs(store, repo)
    )
  })

  ipcMain.handle(
    'gitlab:listMRs',
    async (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        state?: 'opened' | 'merged' | 'closed' | 'all'
        page?: number
        perPage?: number
        query?: string
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const state = normalizeGitLabMRListState(args.state)
      const page = normalizeGitLabPositiveInteger(args.page, 1, 10_000)
      const perPage = normalizeGitLabPositiveInteger(args.perPage, 20, 100)
      return listMergeRequests(
        repo.path,
        state,
        page,
        perPage,
        repo.issueSourcePreference,
        normalizeGitLabSearchQuery(args.query),
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )
}
