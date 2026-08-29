import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import {
  diagnoseAuth,
  getAuthenticatedViewer,
  getProjectSlug,
  getRateLimit,
  listTodos
} from '../gitlab/client'
import { registerGitLabCiJobHandlers } from './gitlab-ci-job-handlers'
import { registerGitLabIssueHandlers } from './gitlab-issue-handlers'
import { registerGitLabMergeRequestMutationHandlers } from './gitlab-merge-request-mutation-handlers'
import { registerGitLabMergeRequestQueryHandlers } from './gitlab-merge-request-query-handlers'
import type { GitLabRepoSelectorArgs } from './gitlab-repo-access'
import {
  assertRegisteredRepo,
  hostedReviewOptionArgs,
  localGitOptionArgs,
  repoConnectionId
} from './gitlab-repo-access'
import { registerGitLabWorkItemHandlers } from './gitlab-work-item-handlers'

export function registerGitLabHandlers(store: Store): void {
  ipcMain.handle('gitlab:viewer', async () => {
    return getAuthenticatedViewer()
  })

  ipcMain.handle('gitlab:diagnoseAuth', async () => diagnoseAuth())

  ipcMain.handle(
    'gitlab:rateLimit',
    async (_event, args?: { force?: boolean; host?: string | null }) =>
      getRateLimit({ force: Boolean(args?.force), host: args?.host ?? null })
  )

  ipcMain.handle('gitlab:projectSlug', async (_event, args: GitLabRepoSelectorArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return getProjectSlug(repo.path, repoConnectionId(repo), ...hostedReviewOptionArgs(store, repo))
  })

  registerGitLabMergeRequestQueryHandlers(store)
  registerGitLabIssueHandlers(store)
  registerGitLabWorkItemHandlers(store)
  registerGitLabMergeRequestMutationHandlers(store)
  registerGitLabCiJobHandlers(store)

  // Why: My Todos surface — cross-project, user-scoped. The repoPath is
  // only used for the registered-repo guard; `glab api todos` doesn't
  // care about cwd because the endpoint is user-scoped.
  ipcMain.handle('gitlab:todos', async (_event, args: GitLabRepoSelectorArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return listTodos(repo.path, repoConnectionId(repo), ...localGitOptionArgs(store, repo))
  })
}
