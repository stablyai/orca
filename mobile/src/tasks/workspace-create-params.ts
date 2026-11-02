import type { TuiAgent } from '../../../src/shared/tui-agent'
import type {
  CreateSparseCheckoutRequest,
  SetupDecision
} from '../../../src/shared/worktree/create-types'
import type { GitPushTarget } from '../../../src/shared/worktree/types'
import type { RpcSendParams } from '../transport/rpc-params-contract'
import {
  buildJiraWorkspaceSource,
  getWorkspaceSourceName
} from '../../../src/shared/new-workspace/workspace-source'
import { resolveMobileWorkspaceCreateName } from './mobile-workspace-name'
import type { WorkspaceAgentChoice } from './workspace-agent-selection'

export type WorkspaceCreateSetupDecision = SetupDecision
export type WorkspaceCreateSparseCheckout = CreateSparseCheckoutRequest
export type WorkspaceCreateGitPushTarget = GitPushTarget

export type WorkspaceCreateHostedStartPoint = {
  baseBranch: string
  pushTarget?: WorkspaceCreateGitPushTarget
}

type WorkspaceCreateGitHubItem = {
  provider: 'github'
  source: {
    type: 'issue' | 'pr'
    repoId: string
    number: number
    title: string
    url: string
  }
}

type WorkspaceCreateGitLabItem = {
  provider: 'gitlab'
  source: {
    type: 'issue' | 'mr'
    repoId: string
    number: number
    title: string
    url: string
  }
}

type WorkspaceCreateLinearItem = {
  provider: 'linear'
  source: {
    identifier: string
    title: string
    url: string
    workspaceId?: string
    organizationUrlKey?: string
  }
}

type WorkspaceCreateJiraItem = {
  provider: 'jira'
  source: {
    key: string
    title: string
    url: string
  }
}

export type WorkspaceCreateTaskItem =
  | WorkspaceCreateGitHubItem
  | WorkspaceCreateGitLabItem
  | WorkspaceCreateLinearItem
  | WorkspaceCreateJiraItem

export type WorkspaceCreateParams = RpcSendParams<'worktree.create'>

// Send agent ids so the host applies launch flags and quoting; legacy create retains them while agent.launch strips them to choose a surface.
export function startupAgentCreateFields(agentId: TuiAgent | undefined): {
  startupAgent?: TuiAgent
  createdWithAgent?: TuiAgent
} {
  if (!agentId) {
    return {}
  }
  return { startupAgent: agentId, createdWithAgent: agentId }
}

export function buildTaskWorkspaceCreateParams(args: {
  item: WorkspaceCreateTaskItem
  targetRepoId: string
  setupDecision: WorkspaceCreateSetupDecision
  agent?: WorkspaceAgentChoice
  workspaceName?: string
  note?: string
  baseBranch?: string
  compareBaseRef?: string
  branchNameOverride?: string
  pushTarget?: WorkspaceCreateGitPushTarget
  sparseCheckout?: WorkspaceCreateSparseCheckout
  hostedStartPoint?: WorkspaceCreateHostedStartPoint
  nameIsAutoManaged?: boolean
}): WorkspaceCreateParams {
  const {
    item,
    targetRepoId,
    setupDecision,
    agent,
    workspaceName,
    note,
    baseBranch,
    compareBaseRef,
    branchNameOverride,
    pushTarget,
    sparseCheckout,
    hostedStartPoint,
    nameIsAutoManaged = true
  } = args
  const shouldLaunchAgent = agent !== 'blank'
  const createdWithAgent = shouldLaunchAgent ? (agent as TuiAgent) : undefined
  const comment = note?.trim()
  const selectedBaseBranch = baseBranch || hostedStartPoint?.baseBranch
  const selectedPushTarget = pushTarget ?? hostedStartPoint?.pushTarget
  // Retain provenance so the host distinguishes deliberate names from generated titles.
  const sourceName =
    item.provider === 'linear'
      ? getWorkspaceSourceName({
          provider: 'linear',
          type: 'issue',
          number: 0,
          title: item.source.title,
          url: item.source.url,
          linearIdentifier: item.source.identifier
        })
      : item.provider === 'jira'
        ? getWorkspaceSourceName(buildJiraWorkspaceSource(item.source))
        : getWorkspaceSourceName({ provider: item.provider, ...item.source })
  const displayName = nameIsAutoManaged
    ? { displayName: sourceName.displayName, displayNameKind: 'generated' as const }
    : workspaceName?.trim()
      ? { displayName: workspaceName, displayNameKind: 'user' as const }
      : {}
  const common = {
    setupDecision,
    activate: true,
    ...(shouldLaunchAgent ? { startupDraft: item.source.url } : {}),
    ...(createdWithAgent ? { createdWithAgent } : {}),
    ...(selectedBaseBranch ? { baseBranch: selectedBaseBranch } : {}),
    ...(compareBaseRef ? { compareBaseRef } : {}),
    ...(branchNameOverride ? { branchNameOverride } : {}),
    ...(selectedPushTarget ? { pushTarget: selectedPushTarget } : {}),
    ...(sparseCheckout ? { sparseCheckout } : {}),
    ...(comment ? { comment } : {})
  }

  if (item.provider === 'github') {
    const fallback = `${item.source.type}-${item.source.number}`
    return {
      repo: `id:${item.source.repoId}`,
      name: resolveMobileWorkspaceCreateName({ draft: workspaceName, fallback }),
      ...displayName,
      ...common,
      ...(item.source.type === 'issue'
        ? { linkedIssue: item.source.number }
        : { linkedPR: item.source.number })
    }
  }

  if (item.provider === 'gitlab') {
    const fallback = `${item.source.type}-${item.source.number}`
    return {
      repo: `id:${item.source.repoId}`,
      name: resolveMobileWorkspaceCreateName({ draft: workspaceName, fallback }),
      ...displayName,
      ...common,
      ...(item.source.type === 'issue'
        ? { linkedGitLabIssue: item.source.number }
        : { linkedGitLabMR: item.source.number })
    }
  }

  if (item.provider === 'jira') {
    return {
      repo: `id:${targetRepoId}`,
      name: resolveMobileWorkspaceCreateName({
        draft: workspaceName,
        fallback: item.source.key.toLowerCase()
      }),
      ...displayName,
      linkedWorkItem: buildJiraWorkspaceSource(item.source),
      ...common
    }
  }

  return {
    repo: `id:${targetRepoId}`,
    name: resolveMobileWorkspaceCreateName({
      draft: workspaceName,
      fallback: item.source.identifier.toLowerCase()
    }),
    ...displayName,
    linkedLinearIssue: item.source.identifier,
    ...(item.source.workspaceId ? { linkedLinearIssueWorkspaceId: item.source.workspaceId } : {}),
    ...(item.source.organizationUrlKey
      ? { linkedLinearIssueOrganizationUrlKey: item.source.organizationUrlKey }
      : {}),
    ...common
  }
}
