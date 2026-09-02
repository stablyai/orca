import { ghPullRequestsAndWorkItemsApi } from './gh-bridge-pull-requests-and-work-items'
import { ghMutationsAndProjectsApi } from './gh-bridge-mutations-and-projects'

export const ghApi = { ...ghPullRequestsAndWorkItemsApi, ...ghMutationsAndProjectsApi }
