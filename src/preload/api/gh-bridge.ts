import type { PreloadApi } from '../api-types'
import { ghPullRequestsAndWorkItemsApi } from './gh-bridge-pull-requests-and-work-items'
import { ghMutationsAndProjectsApi } from './gh-bridge-mutations-and-projects'

import { ghActionsApi } from './gh-bridge-actions'

export const ghApi = {
  ...ghActionsApi,
  ...ghPullRequestsAndWorkItemsApi,
  ...ghMutationsAndProjectsApi
} satisfies PreloadApi['gh']
