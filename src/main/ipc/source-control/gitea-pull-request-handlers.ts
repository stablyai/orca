import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
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

export function registerGiteaPullRequestHandlers(
  store: Store,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle('gitea:prDetail', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaIssueByNumber, args, store)
    return getGiteaPullRequestDetail(target, params.number)
  })

  ipc.handle('gitea:prFiles', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaIssueByNumber, args, store)
    return listGiteaPullRequestFiles(target, params.number)
  })

  ipc.handle('gitea:prFileContents', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaPullRequestFileContents, args, store)
    return getGiteaPullRequestFileContents(target, {
      path: params.path,
      oldPath: params.oldPath,
      status: params.status,
      baseSha: params.baseSha,
      headSha: params.headSha
    })
  })

  ipc.handle('gitea:prChecks', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaPullRequestChecks, args, store)
    return getGiteaPullRequestChecks(target, params.headSha)
  })

  ipc.handle('gitea:prMerge', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaMergePullRequest, args, store)
    return mergeGiteaPullRequest(target, params.number, params.method)
  })

  ipc.handle('gitea:prReviewComments', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaIssueByNumber, args, store)
    return listGiteaPullRequestReviewComments(target, params.number)
  })

  ipc.handle('gitea:prAddReviewComment', async (_event, args: Args) => {
    const { target, params } = parseGiteaRepoArgs(GiteaAddPullRequestReviewComment, args, store)
    return addGiteaPullRequestReviewComment(target, params.number, {
      path: params.path,
      line: params.line,
      body: params.body
    })
  })
}
