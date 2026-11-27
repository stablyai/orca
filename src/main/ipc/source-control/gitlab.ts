import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import type { Store } from '../../persistence/loading-store/store'
import {
  diagnoseAuth,
  getAuthenticatedViewer,
  getRateLimit
} from '../../gitlab/requests/gitlab-auth-and-rate-limit'
import { getProjectSlug } from '../../gitlab/merge-requests/merge-request-lookup'
import { listTodos } from '../../gitlab/work-items/work-item-queries'
import { registerGitLabCiJobHandlers } from './gitlab-ci-job-handlers'
import { registerGitLabIssueHandlers } from './gitlab-issue-handlers'
import { registerGitLabMergeRequestMutationHandlers } from './gitlab-merge-request-mutation-handlers'
import { registerGitLabMergeRequestQueryHandlers } from './gitlab-merge-request-query-handlers'

import {
  type GitLabRepoSelectorArgs,
  assertRegisteredRepo,
  hostedReviewOptionArgs,
  localGitOptionArgs,
  repoConnectionId
} from './gitlab-repo-access'
import { registerGitLabWorkItemHandlers } from './gitlab-work-item-handlers'

export function registerGitLabHandlers(store: Store, ipc: IpcHandleRegistrar = ipcMain): void {
  ipc.handle('gitlab:viewer', async () => {
    return getAuthenticatedViewer()
  })

  ipc.handle('gitlab:diagnoseAuth', async () => diagnoseAuth())

  ipc.handle('gitlab:rateLimit', async (_event, args?: { force?: boolean; host?: string | null }) =>
    getRateLimit({ force: Boolean(args?.force), host: args?.host ?? null })
  )

  ipc.handle('gitlab:projectSlug', async (_event, args: GitLabRepoSelectorArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return getProjectSlug(repo.path, repoConnectionId(repo), ...hostedReviewOptionArgs(store, repo))
  })

  registerGitLabMergeRequestQueryHandlers(store, ipc)
  registerGitLabIssueHandlers(store, ipc)
  registerGitLabWorkItemHandlers(store, ipc)
  registerGitLabMergeRequestMutationHandlers(store, ipc)
  registerGitLabCiJobHandlers(store, ipc)

  // Todos are user-scoped; repoPath is only the registration guard.
  ipc.handle('gitlab:todos', async (_event, args: GitLabRepoSelectorArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return listTodos(repo.path, repoConnectionId(repo), ...localGitOptionArgs(store, repo))
  })
}
