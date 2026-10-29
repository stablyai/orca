import type { PreloadApi } from '../api-types'
import { ghPullRequestsAndWorkItemsApi } from './gh-bridge-pull-requests-and-work-items'
import { ghMutationsAndProjectsApi } from './gh-bridge-mutations-and-projects'

export const ghApi = {
  ...ghPullRequestsAndWorkItemsApi,
  ...ghMutationsAndProjectsApi
} satisfies PreloadApi['gh']
