import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  resolveComposerMrBase,
  resolveComposerPrBase
} from '../source-selection/composer-source-base-resolve'
import type { MobileComposerCreateSelection } from '../source-selection/mobile-composer-source-types'
import { resolveMobileWorkspaceCreateName } from './mobile-workspace-name'
import type { WorkspaceAgentChoice } from './workspace-agent-selection'
import { toTaskItem } from '../source-selection/composer-work-item-task'
import {
  startupAgentCreateFields,
  buildTaskWorkspaceCreateParams,
  type WorkspaceCreateParams
} from './workspace-create-params'
import type { SetupDecision as WorkspaceCreateSetupDecision } from '../../../../src/shared/worktree/create-types'
import {
  createWorktreeWithNameRetry,
  type WorktreeCreateParent,
  type WorktreeCreateResult
} from './worktree-create-retry'
import type { WorktreeCreateAgentLaunch } from '../../session/agent-launch/agent-launch-request'
import type { WorktreeCreateIdempotencyProbe } from './worktree-create-idempotency-policy'
import { getClientWorktreeCreateCandidate } from '../../../../src/shared/new-workspace/worktree-create-retry-policy'

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
  branchIntentSupported?: boolean | Promise<boolean>
  parent?: WorktreeCreateParent
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
  parent?: WorktreeCreateParent
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
    parent: args.parent,
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
  branchIntentSupported?: boolean | Promise<boolean>
  parent?: WorktreeCreateParent
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
      parent: args.parent,
      client,
      baseName,
      worktreeCreateIdempotency: args.worktreeCreateIdempotency,
      ...(agentLaunch ? { agentLaunch } : {}),
      maxAttempts: 1,
      branchIntentSupported: args.branchIntentSupported,
      buildParams: (name) =>
        applyCommon({
          repo: `id:${targetRepoId}`,
          name,
          ...(manualDisplayName
            ? { displayName: manualDisplayName, displayNameKind: 'user' as const }
            : {}),
          setupDecision,
          baseBranch: selection.refName,
          branchNameOverride: selection.localBranchName,
          branchIntent: 'open-existing-v2'
        })
    })
  }

  const baseName = resolveMobileWorkspaceCreateName({
    draft: workspaceName,
    fallback: selection.branchNameOverride || selection.localBranchName
  })
  return createWorktreeWithNameRetry({
    parent: args.parent,
    client,
    baseName,
    worktreeCreateIdempotency: args.worktreeCreateIdempotency,
    branchIntentSupported: args.branchIntentSupported,
    ...(agentLaunch ? { agentLaunch } : {}),
    buildParams: (candidate, attempt) => {
      const params: WorkspaceCreateParams = {
        repo: `id:${targetRepoId}`,
        name: candidate,
        setupDecision,
        branchIntent: 'create-new',
        baseBranch: selection.baseBranch,
        ...(manualDisplayName
          ? { displayName: manualDisplayName, displayNameKind: 'user' as const }
          : {})
      }
      if (selection.branchNameOverride) {
        params.branchNameOverride = getClientWorktreeCreateCandidate(
          selection.branchNameOverride,
          attempt
        )
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
  parent?: WorktreeCreateParent
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
    parent: args.parent,
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
