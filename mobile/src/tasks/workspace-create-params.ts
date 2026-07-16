import type {
  CreateSparseCheckoutRequest,
  GitPushTarget,
  SetupDecision,
  TuiAgent
} from '../../../src/shared/types'
import { getWorkspaceSourceName } from '../../../src/shared/new-workspace/workspace-source'
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

export type WorkspaceCreateTaskItem =
  | WorkspaceCreateGitHubItem
  | WorkspaceCreateGitLabItem
  | WorkspaceCreateLinearItem

export type WorkspaceCreateParams = Record<string, unknown>

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
  // Why: desktop only sends displayName while the name is still auto-derived; a
  // user-edited name suppresses it so the runtime keeps the user's chosen name.
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
      : getWorkspaceSourceName({ provider: item.provider, ...item.source })
  const displayName = nameIsAutoManaged ? { displayName: sourceName.displayName } : {}
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
