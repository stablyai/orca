import { registeredActionsRepo } from './github-actions-repo-routing'
import { registerGitHubActionsArtifactHandlers } from './github-actions-artifact-handlers'
import {
  ActionsRunsQuery as RunsSchema,
  ActionsWorkflowsQuery as WorkflowsSchema,
  ActionsDetailsQuery as DetailsSchema
} from '../../shared/rpc-contract/github-actions-params'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import { ipcMain } from 'electron'
import type {
  ActionsRequestContext,
  ActionsRunsQuery,
  ActionsWorkflowsQuery,
  ActionsDetailsQuery
} from '../../shared/github/actions-types'
import { listActionsRuns, listActionsWorkflows, getWorkflowRunDetails } from '../github/client'
import type { Store } from '../persistence'
import { getGitHubLocalGitOptionArgs } from './github-repo-routing'

/** Validate desktop Actions requests against registered Git repositories before dispatching reads. */
export function registerGitHubActionsReadHandlers(store: Store): void {
  registerGitHubActionsArtifactHandlers(store)
  ipcMain.handle('gh:actionsRuns', (_event, args: ActionsRequestContext & ActionsRunsQuery) => {
    const query = RunsSchema.parse(args)
    const repo = registeredActionsRepo(args, store)
    return listActionsRuns(
      repo.path,
      query,
      getRepoSshConnectionId(repo),
      ...getGitHubLocalGitOptionArgs(store, repo)
    )
  })
  ipcMain.handle(
    'gh:actionsWorkflows',
    (_event, args: ActionsRequestContext & ActionsWorkflowsQuery) => {
      const query = WorkflowsSchema.parse(args)
      const repo = registeredActionsRepo(args, store)
      return listActionsWorkflows(
        repo.path,
        query,
        getRepoSshConnectionId(repo),
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
    }
  )
  ipcMain.handle(
    'gh:actionsRunDetails',
    (_event, args: ActionsRequestContext & ActionsDetailsQuery) => {
      const query = DetailsSchema.parse(args)
      const repo = registeredActionsRepo(args, store)
      return getWorkflowRunDetails(
        repo.path,
        query,
        getRepoSshConnectionId(repo),
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
    }
  )
}
