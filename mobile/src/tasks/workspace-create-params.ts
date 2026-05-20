import type { TuiAgent } from '../../../src/shared/types'
import { resolveMobileWorkspaceCreateName } from './mobile-workspace-name'
import type { WorkspaceAgentChoice } from './workspace-agent-selection'

export type WorkspaceCreateSetupDecision = 'inherit' | 'run' | 'skip'

export type WorkspaceCreateSparseCheckout = {
  directories: string[]
  presetId?: string
}

export type WorkspaceCreateGitPushTarget = {
  remoteName: string
  branchName: string
  remoteUrl?: string
}

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
  branchNameOverride?: string
  sparseCheckout?: WorkspaceCreateSparseCheckout
  hostedStartPoint?: WorkspaceCreateHostedStartPoint
}): WorkspaceCreateParams {
  const {
    item,
    targetRepoId,
    setupDecision,
    agent,
    workspaceName,
    note,
    baseBranch,
    branchNameOverride,
    sparseCheckout,
    hostedStartPoint
  } = args
  const shouldLaunchAgent = agent !== 'blank'
  const createdWithAgent = shouldLaunchAgent ? (agent as TuiAgent) : undefined
  const comment = note?.trim()
  const selectedBaseBranch = baseBranch || hostedStartPoint?.baseBranch
  const common = {
    setupDecision,
    activate: true,
    ...(shouldLaunchAgent ? { startupDraft: item.source.url } : {}),
    ...(createdWithAgent ? { createdWithAgent } : {}),
    ...(selectedBaseBranch ? { baseBranch: selectedBaseBranch } : {}),
    ...(branchNameOverride ? { branchNameOverride } : {}),
    ...(hostedStartPoint?.pushTarget ? { pushTarget: hostedStartPoint.pushTarget } : {}),
    ...(sparseCheckout ? { sparseCheckout } : {}),
    ...(comment ? { comment } : {})
  }

  if (item.provider === 'github') {
    const fallback = `${item.source.type}-${item.source.number}`
    return {
      repo: `id:${item.source.repoId}`,
      name: resolveMobileWorkspaceCreateName({ draft: workspaceName, fallback }),
      displayName: item.source.title,
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
      displayName: item.source.title,
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
    displayName: item.source.title,
    linkedLinearIssue: item.source.identifier,
    ...common
  }
}
