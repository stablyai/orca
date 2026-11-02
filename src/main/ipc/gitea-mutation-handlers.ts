import { ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { getGiteaJobTrace } from '../gitea/actions-job-logs'
import { addGiteaPRComment, addGiteaPRInlineComment } from '../gitea/pull-request-review-comments'
import {
  resolveGiteaPRDiscussion,
  submitGiteaPRReview
} from '../gitea/pull-request-review-mutations'
import { updateGiteaPRReviewers } from '../gitea/pull-request-reviewer-update'
import { closeGiteaPR, mergeGiteaPR, reopenGiteaPR } from '../gitea/pull-request-state-mutations'
import { updateGiteaPR } from '../gitea/pull-request-update'
import { getGiteaWorkItemByPath } from '../gitea/work-item-queries'
import type {
  GiteaMergeStyle,
  GiteaPRInlineCommentInput,
  GiteaPRUpdate,
  GiteaProjectRef,
  GiteaReviewDecision
} from '../../shared/gitea-types'
import {
  assertRegisteredGiteaRepo,
  localGitOptionArgs,
  repoConnectionId,
  type GiteaRepoSelectorArgs
} from './gitea-repo-access'

export function registerGiteaMutationHandlers(store: Store): void {
  ipcMain.handle(
    'gitea:closePR',
    async (
      _event,
      args: GiteaRepoSelectorArgs & { number: number; projectRef?: GiteaProjectRef | null }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return closeGiteaPR(
        repo.path,
        args.number,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:reopenPR',
    async (
      _event,
      args: GiteaRepoSelectorArgs & { number: number; projectRef?: GiteaProjectRef | null }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return reopenGiteaPR(
        repo.path,
        args.number,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:mergePR',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        number: number
        method?: GiteaMergeStyle
        projectRef?: GiteaProjectRef | null
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return mergeGiteaPR(
        repo.path,
        args.number,
        args.method ?? 'merge',
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:updatePR',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        number: number
        updates: GiteaPRUpdate
        projectRef?: GiteaProjectRef | null
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return updateGiteaPR(
        repo.path,
        args.number,
        args.updates,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:updatePRReviewers',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        number: number
        reviewerUsernames: string[]
        projectRef?: GiteaProjectRef | null
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return updateGiteaPRReviewers(
        repo.path,
        args.number,
        args.reviewerUsernames,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:addPRComment',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        number: number
        body: string
        projectRef?: GiteaProjectRef | null
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return addGiteaPRComment(
        repo.path,
        args.number,
        args.body,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:addPRInlineComment',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        number: number
        input: GiteaPRInlineCommentInput
        projectRef?: GiteaProjectRef | null
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return addGiteaPRInlineComment(
        repo.path,
        args.number,
        args.input,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:resolvePRDiscussion',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        number: number
        discussionId: string
        resolved: boolean
        projectRef?: GiteaProjectRef | null
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return resolveGiteaPRDiscussion(
        repo.path,
        args.number,
        args.discussionId,
        args.resolved,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:submitPRReview',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        number: number
        decision: GiteaReviewDecision
        body?: string
        projectRef?: GiteaProjectRef | null
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return submitGiteaPRReview(
        repo.path,
        args.number,
        args.decision,
        args.body,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:jobTrace',
    async (
      _event,
      args: GiteaRepoSelectorArgs & { jobId: number; projectRef?: GiteaProjectRef | null }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return getGiteaJobTrace(
        repo.path,
        args.jobId,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:workItemByPath',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        host: string
        path: string
        number: number
        type: 'issue' | 'pr'
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      const item = await getGiteaWorkItemByPath(
        repo.path,
        { host: args.host, path: args.path },
        args.number,
        args.type,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
      if (!item) {
        return null
      }
      const { repoId, ...rest } = item
      void repoId
      return rest
    }
  )
}
