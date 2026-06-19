import { ipcMain } from 'electron'
import type { GiteaMergeMethod, GiteaPRFileStatus } from '../../shared/types'
import {
  addGiteaPullRequestReviewComment,
  getGiteaPullRequestChecks,
  getGiteaPullRequestDetail,
  getGiteaPullRequestFileContents,
  listGiteaPullRequestFiles,
  listGiteaPullRequestReviewComments,
  mergeGiteaPullRequest
} from '../gitea/pull-requests'
import type { Store } from '../persistence'
import {
  assertRegisteredRepo,
  repoConnectionId,
  type GiteaRepoSelectorArgs
} from './gitea-repo-access'

export function registerGiteaPullRequestHandlers(store: Store): void {
  ipcMain.handle(
    'gitea:prDetail',
    async (_event, args: GiteaRepoSelectorArgs & { number: number }) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.number !== 'number') {
        return null
      }
      return getGiteaPullRequestDetail(repo.path, args.number, repoConnectionId(repo))
    }
  )

  ipcMain.handle(
    'gitea:prFiles',
    async (_event, args: GiteaRepoSelectorArgs & { number: number }) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.number !== 'number') {
        return []
      }
      return listGiteaPullRequestFiles(repo.path, args.number, repoConnectionId(repo))
    }
  )

  ipcMain.handle(
    'gitea:prFileContents',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        path: string
        oldPath?: string
        status: GiteaPRFileStatus
        baseSha: string
        headSha: string
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.path !== 'string' || !args.path) {
        return { original: '', modified: '', originalIsBinary: false, modifiedIsBinary: false }
      }
      return getGiteaPullRequestFileContents(
        repo.path,
        {
          path: args.path,
          oldPath: typeof args.oldPath === 'string' ? args.oldPath : undefined,
          status: args.status,
          baseSha: typeof args.baseSha === 'string' ? args.baseSha : '',
          headSha: typeof args.headSha === 'string' ? args.headSha : ''
        },
        repoConnectionId(repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:prChecks',
    async (_event, args: GiteaRepoSelectorArgs & { headSha: string }) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.headSha !== 'string' || !args.headSha) {
        return []
      }
      return getGiteaPullRequestChecks(repo.path, args.headSha, repoConnectionId(repo))
    }
  )

  ipcMain.handle(
    'gitea:prMerge',
    async (_event, args: GiteaRepoSelectorArgs & { number: number; method?: GiteaMergeMethod }) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.number !== 'number') {
        return { ok: false, error: 'Pull request number is required.' }
      }
      const method: GiteaMergeMethod =
        args.method === 'rebase' || args.method === 'squash' ? args.method : 'merge'
      return mergeGiteaPullRequest(repo.path, args.number, method, repoConnectionId(repo))
    }
  )

  ipcMain.handle(
    'gitea:prReviewComments',
    async (_event, args: GiteaRepoSelectorArgs & { number: number }) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.number !== 'number') {
        return []
      }
      return listGiteaPullRequestReviewComments(repo.path, args.number, repoConnectionId(repo))
    }
  )

  ipcMain.handle(
    'gitea:prAddReviewComment',
    async (
      _event,
      args: GiteaRepoSelectorArgs & { number: number; path: string; line: number; body: string }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.number !== 'number') {
        return { ok: false, error: 'Pull request number is required.' }
      }
      if (typeof args.path !== 'string' || !args.path) {
        return { ok: false, error: 'File path is required.' }
      }
      if (typeof args.line !== 'number') {
        return { ok: false, error: 'Line is required.' }
      }
      if (typeof args.body !== 'string' || !args.body.trim()) {
        return { ok: false, error: 'Comment body is required.' }
      }
      return addGiteaPullRequestReviewComment(
        repo.path,
        args.number,
        { path: args.path, line: args.line, body: args.body.trim() },
        repoConnectionId(repo)
      )
    }
  )
}
