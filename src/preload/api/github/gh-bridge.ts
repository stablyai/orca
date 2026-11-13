import type { PreloadApi } from '../../api-types'
import { ghPullRequestsAndWorkItemsApi } from './gh-bridge-pull-requests-and-work-items'
import { ghMutationsAndProjectsApi } from './gh-bridge-mutations-and-projects'
import { ghPRDetailRecoveryApi } from './gh-bridge-pr-detail-recovery'

export const ghApi = {
  ...ghPullRequestsAndWorkItemsApi,
  ...ghMutationsAndProjectsApi,
  ...ghPRDetailRecoveryApi
} satisfies PreloadApi['gh']
