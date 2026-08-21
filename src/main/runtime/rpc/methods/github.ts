import type { RpcMethod } from '../core'
import { GITHUB_ISSUE_METHODS } from './github-issue-methods'
import { GITHUB_PROJECT_METHODS } from './github-project-methods'
import { GITHUB_PULL_REQUEST_METHODS } from './github-pull-request-methods'
import { GITHUB_PULL_REQUEST_UPDATE_METHODS } from './github-pull-request-update-methods'
import { GITHUB_REPO_WORK_ITEM_METHODS } from './github-repo-work-item-methods'

export const GITHUB_METHODS: RpcMethod[] = [
  ...GITHUB_REPO_WORK_ITEM_METHODS,
  ...GITHUB_ISSUE_METHODS,
  ...GITHUB_PULL_REQUEST_METHODS,
  ...GITHUB_PULL_REQUEST_UPDATE_METHODS,
  ...GITHUB_PROJECT_METHODS
]
