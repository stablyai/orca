import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../src/shared/gitlab-types'
import type { LinearIssue } from '../../../src/shared/linear/issue-types'
import type { BaseRefSearchResult } from '../../../src/shared/repo-types'
import {
  isSmartWorkspaceSourceQueryWithinLimit,
  type SmartNameMode
} from '../../../src/shared/new-workspace/smart-workspace-source-results'
import type { RpcClient } from '../transport/rpc-client'
import { isGitHubWorkItemsSshRemoteRequiredError } from './mobile-work-items'
import type { MrStateFilter } from './mobile-composer-source-types'
import type { JiraIssue, JiraSiteSelection } from '../../../src/shared/jira-types'
import {
  searchBranches,
  searchGitHubItems,
  searchGitLabItems,
  searchJiraIssues,
  searchLinearIssues
} from './smart-source-search-requests'

export type SmartFanOutResult = {
  githubItems: GitHubWorkItem[]
  gitlabItems: GitLabWorkItem[]
  linearIssues: LinearIssue[]
  jiraIssues: JiraIssue[]
  branches: BaseRefSearchResult[]
  needsGitHubRemote: boolean
  error: string
}

const EMPTY: Omit<SmartFanOutResult, 'needsGitHubRemote' | 'error'> = {
  githubItems: [],
  gitlabItems: [],
  linearIssues: [],
  jiraIssues: [],
  branches: []
}

function shouldSearchGitHub(mode: SmartNameMode, githubAvailable: boolean): boolean {
  return githubAvailable && (mode === 'smart' || mode === 'github')
}

function shouldSearchGitLab(mode: SmartNameMode, gitlabAvailable: boolean): boolean {
  return gitlabAvailable && (mode === 'smart' || mode === 'gitlab')
}

function shouldSearchLinear(mode: SmartNameMode, linearAvailable: boolean): boolean {
  return linearAvailable && (mode === 'smart' || mode === 'linear')
}

// Why: the shared row builder only emits Jira rows under the Jira tab, so a
// Smart-mode fan-out would spend a round trip on results nothing renders.
function shouldSearchJira(mode: SmartNameMode, jiraAvailable: boolean): boolean {
  return jiraAvailable && mode === 'jira'
}

function shouldSearchBranches(mode: SmartNameMode, query: string): boolean {
  return mode === 'branches' || (mode === 'smart' && query.trim().length > 0)
}

type FanOutArgs = {
  client: RpcClient
  mode: SmartNameMode
  query: string
  repoId: string | null
  githubAvailable: boolean
  gitlabAvailable: boolean
  linearAvailable: boolean
  jiraAvailable: boolean
  mrStateFilter: MrStateFilter
  linearWorkspaceId: string | null | undefined
  jiraSiteId: JiraSiteSelection | null | undefined
}

// Runs every provider search the active mode needs, concurrently. Smart mode is
// best-effort (a single provider failure never blocks the others); single-provider
// modes surface the failure. No cross-provider ranking/dedup — the shared row
// builder concatenates in provider order.
export async function fanOutSmartSearch(args: FanOutArgs): Promise<SmartFanOutResult> {
  if (!isSmartWorkspaceSourceQueryWithinLimit(args.query)) {
    // Why: the source limit is an outbound-request boundary, not only a render
    // limit; pasted payloads must never fan out to provider CLIs or SSH hosts.
    return { ...EMPTY, needsGitHubRemote: false, error: '' }
  }
  const {
    client,
    mode,
    query,
    repoId,
    githubAvailable,
    gitlabAvailable,
    linearAvailable,
    jiraAvailable,
    mrStateFilter
  } = args
  const isSmart = mode === 'smart'
  const tasks = {
    github:
      shouldSearchGitHub(mode, githubAvailable) && repoId
        ? searchGitHubItems(client, repoId, query)
        : null,
    gitlab:
      shouldSearchGitLab(mode, gitlabAvailable) && repoId
        ? searchGitLabItems(client, repoId, query, mrStateFilter)
        : null,
    linear: shouldSearchLinear(mode, linearAvailable)
      ? searchLinearIssues(client, query, args.linearWorkspaceId)
      : null,
    jira: shouldSearchJira(mode, jiraAvailable)
      ? searchJiraIssues(client, query, args.jiraSiteId)
      : null,
    branches:
      shouldSearchBranches(mode, query) && repoId ? searchBranches(client, repoId, query) : null
  }
  const [github, gitlab, linear, jira, branches] = await Promise.allSettled([
    tasks.github ?? Promise.resolve<GitHubWorkItem[]>([]),
    tasks.gitlab ?? Promise.resolve<GitLabWorkItem[]>([]),
    tasks.linear ?? Promise.resolve<LinearIssue[]>([]),
    tasks.jira ?? Promise.resolve<JiraIssue[]>([]),
    tasks.branches ?? Promise.resolve<BaseRefSearchResult[]>([])
  ])

  let needsGitHubRemote = false
  let error = ''
  const fail = (reason: unknown) => {
    if (!isSmart) {
      error = reason instanceof Error ? reason.message : 'Search failed'
    }
  }
  if (github.status === 'rejected') {
    if (isGitHubWorkItemsSshRemoteRequiredError(github.reason)) {
      needsGitHubRemote = true
    } else {
      fail(github.reason)
    }
  }
  if (gitlab.status === 'rejected') {
    fail(gitlab.reason)
  }
  if (linear.status === 'rejected') {
    fail(linear.reason)
  }
  if (jira.status === 'rejected') {
    fail(jira.reason)
  }
  if (branches.status === 'rejected') {
    fail(branches.reason)
  }

  return {
    ...EMPTY,
    githubItems: github.status === 'fulfilled' ? github.value : [],
    gitlabItems: gitlab.status === 'fulfilled' ? gitlab.value : [],
    linearIssues: linear.status === 'fulfilled' ? linear.value : [],
    jiraIssues: jira.status === 'fulfilled' ? jira.value : [],
    branches: branches.status === 'fulfilled' ? branches.value : [],
    needsGitHubRemote,
    error
  }
}
