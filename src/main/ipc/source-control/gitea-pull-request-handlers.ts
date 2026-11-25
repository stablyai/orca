import { ipcMain } from 'electron'
import { listGiteaPullRequestFiles } from '../../gitea/pull-request-files'
import {
  addGiteaPullRequestReviewComment,
  getGiteaPullRequestChecks,
  getGiteaPullRequestDetail,
  getGiteaPullRequestFileContents,
  listGiteaPullRequestReviewComments,
  mergeGiteaPullRequest
} from '../../gitea/pull-request-review-operations'
import {
  GiteaAddPullRequestReviewComment,
  GiteaIssueByNumber,
  GiteaMergePullRequest,
  GiteaPullRequestChecks,
  GiteaPullRequestFileContents
} from '../../../shared/rpc-contract/source-control/gitea-params'
import type { Store } from '../../persistence/loading-store/store'
import type { GiteaRepoSelectorArgs } from './gitea-repo-access'
import { parseGiteaRepoArgs } from './gitea'

type Args = GiteaRepoSelectorArgs & Record<string, unknown>

export function registerGiteaPullRequestHandlers(store: Store): void {
  ipcMain.handle('gitea:prDetail', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaIssueByNumber, args, store)
    return getGiteaPullRequestDetail(target, params.number)
  })

  ipcMain.handle('gitea:prFiles', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaIssueByNumber, args, store)
    return listGiteaPullRequestFiles(target, params.number)
  })

  ipcMain.handle('gitea:prFileContents', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaPullRequestFileContents, args, store)
    return getGiteaPullRequestFileContents(target, {
      path: params.path,
      oldPath: params.oldPath,
      status: params.status,
      baseSha: params.baseSha,
      headSha: params.headSha
    })
  })

  ipcMain.handle('gitea:prChecks', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaPullRequestChecks, args, store)
    return getGiteaPullRequestChecks(target, params.headSha)
  })

  ipcMain.handle('gitea:prMerge', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaMergePullRequest, args, store)
    return mergeGiteaPullRequest(target, params.number, params.method)
  })

  ipcMain.handle('gitea:prReviewComments', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaIssueByNumber, args, store)
    return listGiteaPullRequestReviewComments(target, params.number)
  })

  ipcMain.handle('gitea:prAddReviewComment', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaAddPullRequestReviewComment, args, store)
    return addGiteaPullRequestReviewComment(target, params.number, {
      path: params.path,
      line: params.line,
      body: params.body
    })
  })
}
