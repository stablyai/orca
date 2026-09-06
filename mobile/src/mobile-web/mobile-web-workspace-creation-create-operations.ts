import {
  MobileWebCreationBlankPayloadSchema,
  MobileWebCreationFromSourcePayloadSchema,
  MobileWebCreationResultSchema,
  type MobileWebCreationSelection
} from '../../../src/shared/mobile-web/workspace-creation-create-contract'
import { buildLinearWorkspaceSource } from '../../../src/shared/new-workspace/workspace-source'
import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../src/shared/gitlab-types'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileComposerCreateSelection } from '../tasks/mobile-composer-source-types'
import { normalizeWorkspaceAgent } from '../tasks/workspace-agent-selection'
import { nativeHostWorkspaceCreationOperations } from '../worktree/native-host-workspace-creation-operations'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import {
  mobileWebHostRepoIdFromHost,
  type MobileWebWorkspaceAuthority
} from './mobile-web-workspace-authority'

export async function executeMobileWebWorkspaceCreationCreateOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  authority: MobileWebWorkspaceAuthority
}): Promise<unknown> {
  const operations = nativeHostWorkspaceCreationOperations(args.client)
  if (args.operation === 'creationCreateBlank') {
    const payload = MobileWebCreationBlankPayloadSchema.parse(args.payload)
    const capabilities = await operations.readRuntimeCapabilities()
    const hostRepoId = args.authority.hostRepoId(payload.repoId)
    const result = await operations.createBlankWorkspace({
      ...payload,
      repoId: hostRepoId,
      agentChoice: requiredAgentChoice(payload.agentChoice),
      comment: payload.comment,
      worktreeCreateIdempotency: capabilities.worktreeCreateIdempotency
    })
    return presentCreatedWorkspace(result, hostRepoId, args.authority)
  }
  if (args.operation === 'creationCreateFromSource') {
    const payload = MobileWebCreationFromSourcePayloadSchema.parse(args.payload)
    const capabilities = await operations.readRuntimeCapabilities()
    const hostRepoId = args.authority.hostRepoId(payload.targetRepoId)
    const selection = await authoritativeSelection(payload.selection, operations, args.authority)
    args.authority.assertHostRepoBinding(payload.targetRepoId, hostRepoId)
    assertSelectionRepoBinding(payload.selection, selection, args.authority)
    const result = await operations.createWorkspaceFromSource({
      ...payload,
      selection,
      targetRepoId: hostRepoId,
      agentChoice: requiredAgentChoice(payload.agentChoice),
      workspaceName: payload.workspaceName,
      note: payload.note,
      sparseCheckout: payload.sparseCheckout,
      worktreeCreateIdempotency: capabilities.worktreeCreateIdempotency
    })
    return presentCreatedWorkspace(result, hostRepoId, args.authority)
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

function assertSelectionRepoBinding(
  pageSelection: MobileWebCreationSelection,
  hostSelection: MobileComposerCreateSelection,
  authority: MobileWebWorkspaceAuthority
): void {
  if (pageSelection.kind === 'work-item' && pageSelection.item.provider !== 'linear') {
    if (
      hostSelection.kind !== 'work-item' ||
      hostSelection.item.provider === 'linear' ||
      !hostSelection.item.repoId
    ) {
      throw new MobileWebBrokerError('conflict')
    }
    authority.assertHostRepoBinding(
      pageSelection.item.repoId,
      mobileWebHostRepoIdFromHost(hostSelection.item.repoId)
    )
  }
}

async function authoritativeSelection(
  selection: MobileWebCreationSelection,
  operations: ReturnType<typeof nativeHostWorkspaceCreationOperations>,
  authority: MobileWebWorkspaceAuthority
): Promise<MobileComposerCreateSelection> {
  if (selection.kind !== 'work-item') {
    return selection
  }
  if (selection.item.provider === 'linear') {
    const linearIdentifier = selection.item.linearIdentifier
    const issues = await operations.searchLinearIssues(linearIdentifier, undefined)
    const issue = issues.find(
      (candidate) => candidate.identifier.toLowerCase() === linearIdentifier.toLowerCase()
    )
    if (!issue) {
      throw new MobileWebBrokerError('not_found')
    }
    return {
      kind: 'work-item',
      item: buildLinearWorkspaceSource(issue),
      branchNameOverride: selection.branchNameOverride
    }
  }
  const hostRepoId = authority.hostRepoId(selection.item.repoId)
  if (selection.item.provider === 'github') {
    const item = await operations.lookupGitHubItem(hostRepoId, selection.item.number)
    requireGitHubIdentity(item, selection.item.type)
    const base =
      item.type === 'pr'
        ? await operations.resolvePrBase({
            repoId: hostRepoId,
            prNumber: item.number,
            headRefName: item.branchName,
            baseRefName: item.baseRefName,
            isCrossRepository: item.isCrossRepository
          })
        : {}
    return {
      kind: 'work-item',
      item: linkedGitHubItem(item, hostRepoId),
      ...base
    }
  }
  const item = await operations.lookupGitLabItemByPath({
    repoId: hostRepoId,
    host: new URL(selection.item.url).host,
    path: gitLabProjectPath(selection.item.url),
    iid: selection.item.number,
    type: selection.item.type
  })
  requireGitLabIdentity(item, selection.item.type)
  const base =
    item.type === 'mr'
      ? await operations.resolveMrBase({
          repoId: hostRepoId,
          mrIid: item.number,
          sourceBranch: item.branchName,
          targetBranch: item.baseRefName,
          isCrossRepository: item.isCrossRepository
        })
      : {}
  return {
    kind: 'work-item',
    item: linkedGitLabItem(item, hostRepoId),
    ...base
  }
}

function linkedGitHubItem(item: GitHubWorkItem, repoId: string) {
  return {
    provider: 'github' as const,
    type: item.type,
    number: item.number,
    title: item.title,
    url: item.url,
    repoId
  }
}

function linkedGitLabItem(item: GitLabWorkItem, repoId: string) {
  return {
    provider: 'gitlab' as const,
    type: item.type,
    number: item.number,
    title: item.title,
    url: item.url,
    repoId
  }
}

function requireGitHubIdentity(
  item: GitHubWorkItem | null,
  type: 'issue' | 'pr'
): asserts item is GitHubWorkItem {
  if (!item || item.type !== type) {
    throw new MobileWebBrokerError('not_found')
  }
}

function requireGitLabIdentity(
  item: GitLabWorkItem | null,
  type: 'issue' | 'mr'
): asserts item is GitLabWorkItem {
  if (!item || item.type !== type) {
    throw new MobileWebBrokerError('not_found')
  }
}

function requiredAgentChoice(value: string) {
  const choice = normalizeWorkspaceAgent(value)
  if (!choice) {
    throw new MobileWebBrokerError('invalid_request')
  }
  return choice
}

function gitLabProjectPath(value: string): string {
  const path = new URL(value).pathname
  const marker = path.indexOf('/-/')
  if (marker <= 0) {
    throw new MobileWebBrokerError('invalid_request')
  }
  return path.slice(1, marker)
}

function presentCreatedWorkspace(
  result: { worktreeId: string; name: string; warning?: string } | { error: string },
  hostRepoId: string,
  authority: MobileWebWorkspaceAuthority
): unknown {
  if ('error' in result) {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebCreationResultSchema.parse({
    workspaceId: authority.registerWorkspace(result.worktreeId, hostRepoId),
    name: result.name,
    warning: result.warning
  })
}
