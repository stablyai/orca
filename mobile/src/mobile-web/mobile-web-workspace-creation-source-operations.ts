import {
  MobileWebCreationBranchSearchResultSchema,
  MobileWebCreationGitHubLookupPayloadSchema,
  MobileWebCreationGitHubLookupResultSchema,
  MobileWebCreationGitHubRepoLookupPayloadSchema,
  MobileWebCreationGitHubSearchResultSchema,
  MobileWebCreationGitLabLookupPayloadSchema,
  MobileWebCreationGitLabLookupResultSchema,
  MobileWebCreationGitLabSearchPayloadSchema,
  MobileWebCreationGitLabSearchResultSchema,
  MobileWebCreationHostedBaseResultSchema,
  MobileWebCreationLinearSearchPayloadSchema,
  MobileWebCreationLinearSearchResultSchema,
  MobileWebCreationMrBasePayloadSchema,
  MobileWebCreationPrBasePayloadSchema,
  MobileWebCreationRepoQueryPayloadSchema,
  MobileWebCreationRepoSlugResultSchema
} from '../../../src/shared/mobile-web/workspace-creation-source-contract'
import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../src/shared/gitlab-types'
import type { LinearIssue } from '../../../src/shared/linear/issue-types'
import type { RpcClient } from '../transport/rpc-client'
import { isGitHubWorkItemsSshRemoteRequiredError } from '../tasks/mobile-work-items'
import { nativeHostWorkspaceCreationOperations } from '../worktree/native-host-workspace-creation-operations'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebWorkspaceCreationSourceOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  authority: MobileWebWorkspaceAuthority
}): Promise<unknown> {
  const operations = nativeHostWorkspaceCreationOperations(args.client)
  if (args.operation === 'creationSearchLinear') {
    const payload = MobileWebCreationLinearSearchPayloadSchema.parse(args.payload)
    const issues = await operations.searchLinearIssues(payload.query, payload.linearWorkspaceId)
    return MobileWebCreationLinearSearchResultSchema.parse({
      issues: issues.map(presentLinearIssue)
    })
  }
  if (args.operation === 'creationSearchGitLab') {
    const payload = MobileWebCreationGitLabSearchPayloadSchema.parse(args.payload)
    const hostRepoId = args.authority.hostRepoId(payload.repoId)
    const items = await operations.searchGitLabItems(hostRepoId, payload.query, payload.state)
    return MobileWebCreationGitLabSearchResultSchema.parse({
      items: items.map((item) => presentGitLabItem(item, payload.repoId))
    })
  }
  if (args.operation === 'creationSearchGitHub' || args.operation === 'creationSearchBranches') {
    const payload = MobileWebCreationRepoQueryPayloadSchema.parse(args.payload)
    const hostRepoId = args.authority.hostRepoId(payload.repoId)
    if (args.operation === 'creationSearchGitHub') {
      const items = await searchGitHubItems(operations, hostRepoId, payload.query)
      return MobileWebCreationGitHubSearchResultSchema.parse({
        items: items.map((item) => presentGitHubItem(item, payload.repoId))
      })
    }
    return MobileWebCreationBranchSearchResultSchema.parse({
      branches: await operations.searchBranches(hostRepoId, payload.query)
    })
  }
  return executeCreationLookupOrBase(args, operations)
}

async function searchGitHubItems(
  operations: ReturnType<typeof nativeHostWorkspaceCreationOperations>,
  repoId: string,
  query: string
): ReturnType<typeof operations.searchGitHubItems> {
  try {
    return await operations.searchGitHubItems(repoId, query)
  } catch (error) {
    if (isGitHubWorkItemsSshRemoteRequiredError(error)) {
      throw new MobileWebBrokerError('not_found')
    }
    throw error
  }
}

async function executeCreationLookupOrBase(
  args: {
    operation: string
    payload: unknown
    authority: MobileWebWorkspaceAuthority
  },
  operations: ReturnType<typeof nativeHostWorkspaceCreationOperations>
): Promise<unknown> {
  if (args.operation === 'creationResolveRepoSlug') {
    const payload = MobileWebCreationRepoQueryPayloadSchema.pick({ repoId: true }).parse(
      args.payload
    )
    return MobileWebCreationRepoSlugResultSchema.parse(
      await operations.resolveGitHubRepoSlug(args.authority.hostRepoId(payload.repoId))
    )
  }
  if (args.operation === 'creationLookupGitHub') {
    const payload = MobileWebCreationGitHubLookupPayloadSchema.parse(args.payload)
    const item = await operations.lookupGitHubItem(
      args.authority.hostRepoId(payload.repoId),
      payload.number
    )
    return MobileWebCreationGitHubLookupResultSchema.parse({
      item: item ? presentGitHubItem(item, payload.repoId) : null
    })
  }
  if (args.operation === 'creationLookupGitHubRepo') {
    const payload = MobileWebCreationGitHubRepoLookupPayloadSchema.parse(args.payload)
    const item = await operations.lookupGitHubItemByOwnerRepo({
      ...payload,
      repoId: args.authority.hostRepoId(payload.repoId)
    })
    return MobileWebCreationGitHubLookupResultSchema.parse({
      item: item ? presentGitHubItem(item, payload.repoId) : null
    })
  }
  if (args.operation === 'creationLookupGitLab') {
    const payload = MobileWebCreationGitLabLookupPayloadSchema.parse(args.payload)
    const item = await operations.lookupGitLabItemByPath({
      ...payload,
      repoId: args.authority.hostRepoId(payload.repoId)
    })
    return MobileWebCreationGitLabLookupResultSchema.parse({
      item: item ? presentGitLabItem(item, payload.repoId) : null
    })
  }
  if (args.operation === 'creationResolvePrBase') {
    const payload = MobileWebCreationPrBasePayloadSchema.parse(args.payload)
    return presentHostedBase(
      await operations.resolvePrBase({
        ...payload,
        repoId: args.authority.hostRepoId(payload.repoId)
      })
    )
  }
  if (args.operation === 'creationResolveMrBase') {
    const payload = MobileWebCreationMrBasePayloadSchema.parse(args.payload)
    return presentHostedBase(
      await operations.resolveMrBase({
        ...payload,
        repoId: args.authority.hostRepoId(payload.repoId)
      })
    )
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

function presentGitHubItem(item: GitHubWorkItem, pageRepoId: string): unknown {
  return {
    id: `github:${pageRepoId}:${item.type}:${item.number}`,
    type: item.type,
    number: item.number,
    title: item.title,
    state: item.state,
    url: sanitizedProviderUrl(item.url),
    labels: item.labels,
    updatedAt: item.updatedAt,
    author: item.author,
    branchName: item.branchName,
    baseRefName: item.baseRefName,
    isCrossRepository: item.isCrossRepository,
    repoId: pageRepoId
  }
}

function presentGitLabItem(item: GitLabWorkItem, pageRepoId: string): unknown {
  return {
    id: `gitlab:${pageRepoId}:${item.type}:${item.number}`,
    type: item.type,
    number: item.number,
    title: item.title,
    state: item.state,
    url: sanitizedProviderUrl(item.url),
    labels: item.labels,
    updatedAt: item.updatedAt,
    author: item.author,
    branchName: item.branchName,
    baseRefName: item.baseRefName,
    isCrossRepository: item.isCrossRepository,
    repoId: pageRepoId
  }
}

function presentLinearIssue(issue: LinearIssue): unknown {
  return {
    id: `linear:${issue.identifier}`,
    identifier: issue.identifier,
    title: issue.title,
    branchName: issue.branchName,
    url: sanitizedProviderUrl(issue.url),
    state: issue.state,
    team: { id: `linear-team:${issue.team.key}`, name: issue.team.name, key: issue.team.key },
    labels: issue.labels,
    labelIds: issue.labels.map((label) => `linear-label:${label}`),
    priority: issue.priority,
    updatedAt: issue.updatedAt
  }
}

function presentHostedBase(result: {
  baseBranch: string
  compareBaseRef?: string
  pushTarget?: { remoteName: string; branchName: string }
  branchNameOverride?: string
  maintainerCanModify?: boolean
}): unknown {
  return MobileWebCreationHostedBaseResultSchema.parse({
    baseBranch: result.baseBranch,
    compareBaseRef: result.compareBaseRef,
    pushTarget: result.pushTarget
      ? {
          remoteName: result.pushTarget.remoteName,
          branchName: result.pushTarget.branchName
        }
      : undefined,
    branchNameOverride: result.branchNameOverride,
    maintainerCanModify: result.maintainerCanModify
  })
}

function sanitizedProviderUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MobileWebBrokerError('host_error')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString()
}
