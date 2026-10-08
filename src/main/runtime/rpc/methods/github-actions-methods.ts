import { GITHUB_ACTIONS_ARTIFACT_METHODS } from './github-actions-artifact-methods'
import { defineMethod } from '../core'
import {
  ActionsRuns,
  ActionsWorkflows,
  ActionsRunDetails
} from '../../../../shared/rpc-contract/github-actions-params'
export const GITHUB_ACTIONS_METHODS = [
  ...GITHUB_ACTIONS_ARTIFACT_METHODS,
  defineMethod({
    name: 'github.actionsRuns',
    params: ActionsRuns,
    /** Read the selected run page on its execution host with caller cancellation. */
    handler: (params, { runtime, signal }) =>
      runtime.getRepoActionsRuns(params.repo, params, signal)
  }),
  defineMethod({
    name: 'github.actionsWorkflows',
    params: ActionsWorkflows,
    /** Read workflow paging on the execution host with caller cancellation. */
    handler: (params, { runtime, signal }) =>
      runtime.getRepoActionsWorkflows(params.repo, params, signal)
  }),
  defineMethod({
    name: 'github.actionsRunDetails',
    params: ActionsRunDetails,
    /** Read attempt-specific job details on the execution host with caller cancellation. */
    handler: (params, { runtime, signal }) =>
      runtime.getRepoActionsRunDetails(params.repo, params, signal)
  })
]
