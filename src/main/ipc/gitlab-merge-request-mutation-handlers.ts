import { ipcMain } from 'electron'
import type { GitLabMRInlineCommentInput, GitLabMRUpdate } from '../../shared/gitlab-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { Store } from '../persistence'
import {
  addMRComment,
  addMRInlineComment,
  closeMR,
  mergeMR,
  reopenMR,
  resolveMRDiscussion,
  updateMR,
  updateMRReviewers
} from '../gitlab/client'
import type { ProjectRef } from '../gitlab/gl-utils'
import type { GitLabRepoSelectorArgs } from './gitlab-repo-access'
import { assertRegisteredRepo, localGitOptionArgs, repoConnectionId } from './gitlab-repo-access'

export function registerGitLabMergeRequestMutationHandlers(store: Store): void {
  ipcMain.handle(
    'gitlab:closeMR',
    async (_event, args: GitLabRepoSelectorArgs & { iid: number }) => {
      const repo = assertRegisteredRepo(args, store)
      return closeMR(
        repo.path,
        args.iid,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:reopenMR',
    async (_event, args: GitLabRepoSelectorArgs & { iid: number }) => {
      const repo = assertRegisteredRepo(args, store)
      return reopenMR(
        repo.path,
        args.iid,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:mergeMR',
    async (
      _event,
      args: GitLabRepoSelectorArgs & { iid: number; method?: 'merge' | 'squash' | 'rebase' }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return mergeMR(
        repo.path,
        args.iid,
        args.method ?? 'merge',
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:updateMR',
    async (_event, args: GitLabRepoSelectorArgs & { iid: number; updates: GitLabMRUpdate }) => {
      const repo = assertRegisteredRepo(args, store)
      return updateMR(
        repo.path,
        args.iid,
        args.updates,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:updateMRReviewers',
    async (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        iid: number
        reviewerIds: number[]
        projectRef?: ProjectRef | null
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return updateMRReviewers(
        repo.path,
        args.iid,
        args.reviewerIds,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:addMRComment',
    async (_event, args: GitLabRepoSelectorArgs & { iid: number; body: string }) => {
      const repo = assertRegisteredRepo(args, store)
      return addMRComment(
        repo.path,
        args.iid,
        args.body,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:addMRInlineComment',
    async (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        iid: number
        input: GitLabMRInlineCommentInput
        projectRef?: ProjectRef | null
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return addMRInlineComment(
        repo.path,
        args.iid,
        args.input,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:resolveMRDiscussion',
    async (
      _event,
      args: GitLabRepoSelectorArgs & { iid: number; discussionId: string; resolved: boolean }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return resolveMRDiscussion(
        repo.path,
        args.iid,
        args.discussionId,
        args.resolved,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )
}
