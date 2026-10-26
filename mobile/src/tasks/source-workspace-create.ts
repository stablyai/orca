import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcClient } from '../transport/rpc-client'
import { resolveComposerMrBase, resolveComposerPrBase } from './composer-source-base-resolve'
import type {
  MobileComposerCreateSelection,
  MobileLinkedWorkItem
} from './mobile-composer-source-types'
import { resolveMobileWorkspaceCreateName } from './mobile-workspace-name'
import type { WorkspaceAgentChoice } from './workspace-agent-selection'
import {
  startupAgentCreateFields,
  buildTaskWorkspaceCreateParams,
  type WorkspaceCreateParams,
  type WorkspaceCreateSetupDecision,
  type WorkspaceCreateTaskItem
} from './workspace-create-params'
import { createWorktreeWithNameRetry, type WorktreeCreateResult } from './worktree-create-retry'
import type { WorktreeCreateAgentLaunch } from './agent-launch-request'
import type { WorktreeCreateIdempotencyProbe } from './worktree-create-idempotency-policy'

// Host resolution applies agent permission flags and shell quoting.
export type WorkspaceCreateAgentBundle = {
  choice: WorkspaceAgentChoice
}

export type CreateWorkspaceFromComposerArgs = {
  client: RpcClient
  selection: MobileComposerCreateSelection
  targetRepoId: string
  setupDecision: WorkspaceCreateSetupDecision
  agent: WorkspaceCreateAgentBundle
  workspaceName: string | undefined
  nameIsAutoManaged?: boolean
  note: string | undefined
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
  agentLaunchSupported: WorktreeCreateAgentLaunch['supported']
}

export async function createWorkspaceFromComposerSource(
  args: CreateWorkspaceFromComposerArgs
): Promise<WorktreeCreateResult> {
  if (args.selection.kind === 'branch') {
    return createBranchWorkspace({ ...args, selection: args.selection })
  }
  if (args.selection.kind === 'new-branch') {
    return createNewBranchWorkspace({ ...args, selection: args.selection })
  }
  return createWorkItemWorkspace({ ...args, selection: args.selection })
}

function resolveComposerAgentLaunch(
  agentId: TuiAgent | undefined,
  supported: WorktreeCreateAgentLaunch['supported']
): WorktreeCreateAgentLaunch | undefined {
  return agentId ? { agent: agentId, supported } : undefined
}

function toTaskItem(item: MobileLinkedWorkItem, targetRepoId: string): WorkspaceCreateTaskItem {
  if (item.provider === 'github') {
    return {
      provider: 'github',
      source: {
        type: item.type === 'pr' ? 'pr' : 'issue',
        repoId: item.repoId ?? targetRepoId,
        number: item.number,
        title: item.title,
        url: item.url
      }
    }
  }
  if (item.provider === 'gitlab') {
    return {
      provider: 'gitlab',
      source: {
        type: item.type === 'mr' ? 'mr' : 'issue',
        repoId: item.repoId ?? targetRepoId,
        number: item.number,
        title: item.title,
        url: item.url
      }
    }
  }
  if (item.provider === 'jira') {
    return {
      provider: 'jira',
      source: {
        key: item.jiraIdentifier ?? '',
        title: item.title,
        url: item.url
      }
    }
  }
  return {
    provider: 'linear',
    source: {
      identifier: item.linearIdentifier ?? '',
      title: item.title,
      url: item.url,
      ...(item.linearWorkspaceId ? { workspaceId: item.linearWorkspaceId } : {}),
      ...(item.linearOrganizationUrlKey
        ? { organizationUrlKey: item.linearOrganizationUrlKey }
        : {})
    }
  }
}

async function createWorkItemWorkspace(args: {
  client: RpcClient
  selection: Extract<MobileComposerCreateSelection, { kind: 'work-item' }>
  targetRepoId: string
  setupDecision: WorkspaceCreateSetupDecision
  agent: WorkspaceCreateAgentBundle
  workspaceName: string | undefined
  nameIsAutoManaged?: boolean
  note: string | undefined
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
}): Promise<WorktreeCreateResult> {
  const { client, selection, targetRepoId, setupDecision, agent, workspaceName, note } = args
  const item = selection.item
  const taskItem = toTaskItem(item, targetRepoId)

  // Reuse select-time PR/MR base resolution; resolve again only when a linked item lacks it.
  let baseBranch = selection.baseBranch
  let compareBaseRef = selection.compareBaseRef
  let pushTarget = selection.pushTarget
  let branchNameOverride = selection.branchNameOverride
  if (!baseBranch && item.provider !== 'linear' && (item.type === 'pr' || item.type === 'mr')) {
    const repoId = item.repoId ?? targetRepoId
    const resolved =
      item.type === 'pr'
        ? await resolveComposerPrBase({ client, repoId, prNumber: item.number }).catch(() => null)
        : await resolveComposerMrBase({ client, repoId, mrIid: item.number }).catch(() => null)
    if (resolved) {
      baseBranch = resolved.baseBranch
      compareBaseRef = resolved.compareBaseRef
      pushTarget = resolved.pushTarget
      branchNameOverride = resolved.branchNameOverride ?? branchNameOverride
    }
  }

  const params = buildTaskWorkspaceCreateParams({
    item: taskItem,
    targetRepoId,
    setupDecision,
    agent: agent.choice,
    workspaceName,
    note,
    baseBranch,
    compareBaseRef,
    branchNameOverride,
    pushTarget,
    nameIsAutoManaged: args.nameIsAutoManaged
  })
  // Reuse the computed name for collision suffixes, matching blank-workspace creation.
  const baseName = String(params.name)
  // Keep linked work items on terminals: structured sessions cannot hold their unsent URL draft and would submit it as a turn.
  return createWorktreeWithNameRetry({
    client,
    baseName,
    worktreeCreateIdempotency: args.worktreeCreateIdempotency,
    buildParams: (name) => ({ ...params, name })
  })
}

async function createBranchWorkspace(args: {
  client: RpcClient
  selection: Extract<MobileComposerCreateSelection, { kind: 'branch' }>
  targetRepoId: string
  setupDecision: WorkspaceCreateSetupDecision
  agent: WorkspaceCreateAgentBundle
  workspaceName: string | undefined
  nameIsAutoManaged?: boolean
  note: string | undefined
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
  agentLaunchSupported: WorktreeCreateAgentLaunch['supported']
}): Promise<WorktreeCreateResult> {
  const {
    client,
    selection,
    targetRepoId,
    setupDecision,
    agent,
    workspaceName,
    nameIsAutoManaged,
    note
  } = args
  const createdWithAgentId = agent.choice === 'blank' ? undefined : agent.choice
  const agentLaunch = resolveComposerAgentLaunch(createdWithAgentId, args.agentLaunchSupported)
  const comment = note?.trim()
  const manualDisplayName = nameIsAutoManaged === true ? undefined : workspaceName?.trim()
  const applyCommon = (params: WorkspaceCreateParams): WorkspaceCreateParams => {
    Object.assign(params, startupAgentCreateFields(createdWithAgentId))
    if (comment) {
      params.comment = comment
    }
    return params
  }

  if (selection.reuse) {
    // A reused branch is fixed; display-name suffixes cannot resolve its collision, so fail before wasting retries.
    const baseName = resolveMobileWorkspaceCreateName({
      draft: workspaceName,
      fallback: selection.localBranchName
    })
    return createWorktreeWithNameRetry({
      client,
      baseName,
      worktreeCreateIdempotency: args.worktreeCreateIdempotency,
      ...(agentLaunch ? { agentLaunch } : {}),
      maxAttempts: 1,
      buildParams: (name) =>
        applyCommon({
          repo: `id:${targetRepoId}`,
          name,
          ...(manualDisplayName
            ? { displayName: manualDisplayName, displayNameKind: 'user' as const }
            : {}),
          setupDecision,
          baseBranch: selection.refName,
          branchNameOverride: selection.localBranchName
        })
    })
  }

  const baseName = resolveMobileWorkspaceCreateName({
    draft: workspaceName,
    fallback: selection.branchNameOverride || selection.localBranchName
  })
  return createWorktreeWithNameRetry({
    client,
    baseName,
    worktreeCreateIdempotency: args.worktreeCreateIdempotency,
    ...(agentLaunch ? { agentLaunch } : {}),
    buildParams: (candidate) => {
      const params: WorkspaceCreateParams = {
        repo: `id:${targetRepoId}`,
        name: candidate,
        setupDecision,
        baseBranch: selection.baseBranch,
        ...(manualDisplayName
          ? { displayName: manualDisplayName, displayNameKind: 'user' as const }
          : {})
      }
      if (selection.branchNameOverride) {
        params.branchNameOverride = candidate
      }
      return applyCommon(params)
    }
  })
}

async function createNewBranchWorkspace(args: {
  client: RpcClient
  selection: Extract<MobileComposerCreateSelection, { kind: 'new-branch' }>
  targetRepoId: string
  setupDecision: WorkspaceCreateSetupDecision
  agent: WorkspaceCreateAgentBundle
  workspaceName: string | undefined
  nameIsAutoManaged?: boolean
  note: string | undefined
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
  agentLaunchSupported: WorktreeCreateAgentLaunch['supported']
}): Promise<WorktreeCreateResult> {
  const {
    client,
    selection,
    targetRepoId,
    setupDecision,
    agent,
    workspaceName,
    nameIsAutoManaged,
    note
  } = args
  const createdWithAgentId = agent.choice === 'blank' ? undefined : agent.choice
  const agentLaunch = resolveComposerAgentLaunch(createdWithAgentId, args.agentLaunchSupported)
  const manualDisplayName = nameIsAutoManaged === true ? undefined : workspaceName?.trim()
  const comment = note?.trim()
  // Preserve typed git branch names, including slashes; sanitize only the folder, and retry suffixes against the branch name.
  return createWorktreeWithNameRetry({
    client,
    baseName: selection.branchName,
    worktreeCreateIdempotency: args.worktreeCreateIdempotency,
    ...(agentLaunch ? { agentLaunch } : {}),
    buildParams: (candidate) => {
      const params: WorkspaceCreateParams = {
        repo: `id:${targetRepoId}`,
        name: candidate,
        setupDecision,
        branchNameOverride: candidate,
        ...(manualDisplayName
          ? { displayName: manualDisplayName, displayNameKind: 'user' as const }
          : {}),
        ...startupAgentCreateFields(createdWithAgentId)
      }
      if (comment) {
        params.comment = comment
      }
      return params
    }
  })
}
