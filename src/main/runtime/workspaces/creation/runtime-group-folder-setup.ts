import { blockedWslDistroForPath } from '../../../wsl/filesystem/wsl-unc-access-gate'
import type {
  FolderWorkspaceCreateInput,
  FolderWorkspaceCreateResult
} from '../../../../shared/folder-workspaces/folder-workspace-create'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { projectGroupHookOwner } from '../../../../shared/workspace-hook-owner'
import { isRepoOnCatalogHost } from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  prepareRuntimeLocalWorktreeSetup,
  buildRuntimeSetupReceipt,
  resolveRuntimeSetupDecision
} from './runtime-local-worktree-setup'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import {
  startRuntimeLocalWorktreeTerminals,
  type RuntimeLocalWorktreeTerminalPorts
} from '../startup/runtime-local-worktree-terminal-startup'
import { resolveManagedWorktreeCreateStartup } from '../startup/managed-worktree-create-startup'
import { waitForStructuredSetup } from '../../rpc/methods/agent-launch/agent-launch-worktree-creation'

export type RuntimeGroupFolderCreateInput = FolderWorkspaceCreateInput &
  Pick<
    RuntimeManagedWorktreeCreateArgs,
    | 'startupCwd'
    | 'startupPaneKey'
    | 'startupAccountEnv'
    | 'onStartupTerminalCreated'
    | 'onStartupPromptCarry'
    | 'onWorkspaceCreated'
  > & {
    creatorProvenance?: FolderWorkspace['creatorProvenance']
    rendererOwnsSetup?: boolean
    signal?: AbortSignal
  }

export function groupFolderCreationIsUserAct(input: RuntimeGroupFolderCreateInput): boolean {
  return Boolean(
    input.rendererOwnsSetup ||
    input.startupAgent ||
    input.startupCommand ||
    input.agentLaunchMode ||
    input.setupDecision !== undefined
  )
}

export async function prepareGroupFolderCreation(args: {
  input: RuntimeGroupFolderCreateInput
  group: ProjectGroup
  workspace: FolderWorkspace
  settings: ReturnType<RuntimeStore['getSettings']>
  ports: RuntimeLocalWorktreeTerminalPorts
  startupBuilders: Parameters<typeof resolveManagedWorktreeCreateStartup>[2]
  wait: (handle: string, signal: AbortSignal) => Promise<{ exitCode: number | null }>
}): Promise<FolderWorkspaceCreateResult> {
  const { input, workspace, group } = args
  const result: FolderWorkspaceCreateResult = { folderWorkspace: workspace }
  const owner = projectGroupHookOwner(group)
  const skip = resolveRuntimeSetupDecision(input) === 'skip'
  let prepared: Awaited<ReturnType<typeof prepareRuntimeLocalWorktreeSetup>> | undefined
  if (owner && isRepoOnCatalogHost(owner) && !skip) {
    try {
      if (
        !groupFolderCreationIsUserAct(input) &&
        input.setupDecision !== 'run' &&
        (await blockedWslDistroForPath(owner.path))
      ) {
        throw new Error('The group’s WSL distro is not running.')
      }
      prepared = await prepareRuntimeLocalWorktreeSetup({
        request: input,
        repo: owner,
        worktreePath: owner.path,
        identity: {
          worktreeId: folderWorkspaceKey(workspace.id),
          displayName: workspace.name,
          workspacePath: workspace.folderPath
        },
        settings: args.settings,
        runtimeTarget: undefined,
        shouldUseSetupRunner: true
      })
      if (prepared.setup) {
        prepared.setup = { ...prepared.setup, cwd: owner.path }
      }
      result.warning = prepared.warning
      result.setupTrustMismatch = prepared.setupTrustMismatch
    } catch (error) {
      console.warn('[hooks] group setup preparation failed:', error)
      result.warning = 'Setup did not run. Check the group’s workspace hooks and try Setup again.'
    }
  }
  if (input.rendererOwnsSetup && input.agentLaunchMode !== 'structured') {
    result.setup = prepared?.setup
    return result
  }
  const request = {
    ...input,
    ...(input.startupCommand
      ? {
          startup: {
            command: input.startupCommand,
            env: input.startupEnv,
            launchConfig: input.startupLaunchConfig,
            startupCommandDelivery: input.startupCommandDelivery
          }
        }
      : {}),
    startupLaunchSource: input.launchSource,
    awaitTerminalProvisioning: true,
    observeSetupCompletion: input.agentLaunchMode === 'structured',
    setupOnly: input.agentLaunchMode === 'structured'
  }
  const built = await resolveManagedWorktreeCreateStartup(
    request,
    args.settings.disabledTuiAgents,
    args.startupBuilders
  )
  const started = await startRuntimeLocalWorktreeTerminals({
    request,
    repo: { id: group.id },
    worktree: folderWorkspaceToWorktree(workspace),
    setup: prepared?.setup,
    startup: built.effectiveStartup,
    startupFollowup: built.effectiveStartupFollowup,
    draftPaste: built.effectiveDraftPaste,
    startupLaunchRuntime: built.startupLaunchRuntime,
    createdWithAgent: built.effectiveCreatedWithAgent,
    promisedAgentChat: input.agentLaunchMode === 'structured',
    ports: args.ports
  })
  // Host-owned provisioning is never retried by renderer activation.
  result.setup = undefined
  result.warning = started.warning ?? result.warning
  if (prepared) {
    result.setupReceipt = buildRuntimeSetupReceipt(
      prepared,
      started.didSpawnSetup,
      started.setupTerminalHandle
    )
  }
  if (started.didSpawnStartup) {
    result.startupTerminal = {
      spawned: true,
      handle: started.startupTerminalHandle ?? undefined,
      tabId: started.startupTerminalTabId ?? undefined,
      paneKey: started.startupTerminalPaneKey,
      ptyId: started.startupTerminalPtyId,
      surface: 'background'
    }
  }
  if (input.agentLaunchMode === 'structured') {
    await waitForStructuredSetup({ waitForSetupTerminalCompletion: args.wait }, result.setupReceipt)
  }
  return result
}
