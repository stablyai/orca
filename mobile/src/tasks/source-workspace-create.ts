import type { RpcClient } from '../transport/rpc-client'
import { resolveComposerMrBase, resolveComposerPrBase } from './composer-source-base-resolve'
import type {
  MobileComposerCreateSelection,
  MobileLinkedWorkItem
} from './mobile-composer-source-types'
import { resolveMobileWorkspaceCreateName } from './mobile-workspace-name'
import type { WorkspaceAgentChoice } from './workspace-agent-selection'
import {
  buildTaskWorkspaceCreateParams,
  type WorkspaceCreateSetupDecision,
  type WorkspaceCreateTaskItem
} from './workspace-create-params'
import { createWorktreeWithNameRetry, type WorktreeCreateResult } from './worktree-create-retry'

// The agent bundle the modal already resolved: the choice drives
// buildTaskWorkspaceCreateParams for work-item sources; the explicit launch
// command is used for branch sources (which have no work-item URL to seed the draft).
export type WorkspaceCreateAgentBundle = {
  choice: WorkspaceAgentChoice
  startupCommand: string | undefined
}

export type CreateWorkspaceFromComposerArgs = {
  client: RpcClient
  selection: MobileComposerCreateSelection
  targetRepoId: string
  setupDecision: WorkspaceCreateSetupDecision
  agent: WorkspaceCreateAgentBundle
  workspaceName: string | undefined
  note: string | undefined
  nameIsAutoManaged?: boolean
  supportsIdempotentCutoverRetry: boolean | Promise<boolean>
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
  note: string | undefined
  nameIsAutoManaged?: boolean
  supportsIdempotentCutoverRetry: boolean | Promise<boolean>
}): Promise<WorktreeCreateResult> {
  const { client, selection, targetRepoId, setupDecision, agent, workspaceName, note } = args
  const item = selection.item
  const taskItem = toTaskItem(item, targetRepoId)

  // The composer resolves PR/MR base at select time; only re-resolve as a
  // fallback when a linked PR/MR reached create without one.
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
  // buildTaskWorkspaceCreateParams computes the name; reuse it as the retry base
  // so collisions still append -2, -3, ... like the blank path does.
  const baseName = String(params.name)
  return createWorktreeWithNameRetry({
    client,
    baseName,
    supportsIdempotentCutoverRetry: args.supportsIdempotentCutoverRetry,
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
  note: string | undefined
  supportsIdempotentCutoverRetry: boolean | Promise<boolean>
}): Promise<WorktreeCreateResult> {
  const { client, selection, targetRepoId, setupDecision, agent, workspaceName, note } = args
  const createdWithAgentId = agent.choice === 'blank' ? undefined : agent.choice
  const comment = note?.trim()
  const applyCommon = (params: Record<string, unknown>): Record<string, unknown> => {
    if (createdWithAgentId) {
      params.createdWithAgent = createdWithAgentId
    }
    if (comment) {
      params.comment = comment
    }
    return params
  }

  if (selection.reuse) {
    // Reusing a fixed existing branch: branchNameOverride is pinned to the reused
    // branch, so a branch collision can't be cleared by suffixing the display
    // name — fail fast instead of burning the retry budget.
    const baseName = resolveMobileWorkspaceCreateName({
      draft: workspaceName,
      fallback: selection.localBranchName
    })
    return createWorktreeWithNameRetry({
      client,
      baseName,
      supportsIdempotentCutoverRetry: args.supportsIdempotentCutoverRetry,
      maxAttempts: 1,
      buildParams: (name) =>
        applyCommon({
          repo: `id:${targetRepoId}`,
          name,
          setupDecision,
          baseBranch: selection.refName,
          branchNameOverride: selection.localBranchName,
          startupCommand: agent.startupCommand
        })
    })
  }

  // New branch off the selected ref. The retry base is the branch name so a
  // collision bumps the branch itself.
  const baseName = resolveMobileWorkspaceCreateName({
    draft: workspaceName,
    fallback: selection.branchNameOverride || selection.localBranchName
  })
  return createWorktreeWithNameRetry({
    client,
    baseName,
    supportsIdempotentCutoverRetry: args.supportsIdempotentCutoverRetry,
    buildParams: (candidate) => {
      const params: Record<string, unknown> = {
        repo: `id:${targetRepoId}`,
        name: candidate,
        setupDecision,
        baseBranch: selection.baseBranch,
        startupCommand: agent.startupCommand
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
  note: string | undefined
  supportsIdempotentCutoverRetry: boolean | Promise<boolean>
}): Promise<WorktreeCreateResult> {
  const { client, selection, targetRepoId, setupDecision, agent, note } = args
  const createdWithAgentId = agent.choice === 'blank' ? undefined : agent.choice
  const comment = note?.trim()
  // A brand-new branch off the repo's default base. The typed name is kept as the
  // git branch (via branchNameOverride) so a slash like `feature/login` survives;
  // the runtime sanitizes the worktree folder from the same name. The retry base is
  // the branch name so a collision bumps the branch (and folder) together.
  return createWorktreeWithNameRetry({
    client,
    baseName: selection.branchName,
    supportsIdempotentCutoverRetry: args.supportsIdempotentCutoverRetry,
    buildParams: (candidate) => {
      const params: Record<string, unknown> = {
        repo: `id:${targetRepoId}`,
        name: candidate,
        setupDecision,
        branchNameOverride: candidate,
        startupCommand: agent.startupCommand
      }
      if (createdWithAgentId) {
        params.createdWithAgent = createdWithAgentId
      }
      if (comment) {
        params.comment = comment
      }
      return params
    }
  })
}
