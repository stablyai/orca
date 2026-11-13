import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import { SETUP_AGENT_WAIT_TIMEOUT_SECONDS } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
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
import { resolveWorktreeCreateAgentStartup } from '../startup/runtime-worktree-agent-startup'
import { groupSetupAgentOutcome } from './group-setup-agent-outcome'

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
  buildStartup: Parameters<typeof resolveWorktreeCreateAgentStartup>[1]
  wait: (handle: string, signal: AbortSignal) => Promise<{ exitCode: number | null }>
}): Promise<FolderWorkspaceCreateResult> {
  const { input, workspace, group } = args
  const result: FolderWorkspaceCreateResult = { folderWorkspace: workspace }
  const owner = projectGroupHookOwner(group)
  const skip = resolveRuntimeSetupDecision(input) === 'skip'
  if (!owner || !isRepoOnCatalogHost(owner) || skip) {
    result.agentLaunchOutcome = { status: 'not-required' }
  }
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
        shouldUseSetupRunner: true,
        requireReadableConfig: true
      })
      if (prepared.setup) {
        prepared.setup = { ...prepared.setup, cwd: owner.path }
      }
      result.warning = prepared.warning
      result.setupTrustMismatch = prepared.setupTrustMismatch
    } catch (error) {
      console.warn('[hooks] group setup preparation failed:', error)
      result.warning = 'Setup did not run. Check the group’s workspace hooks and try Setup again.'
      result.agentLaunchOutcome = { status: 'failed', reason: 'preparation' }
    }
  }
  const required = Boolean(prepared?.shouldRunSetup && prepared.waitForAgentStartup)
  if (required && !prepared?.setup) {
    result.agentLaunchOutcome = { status: 'failed', reason: 'preparation' }
  }
  if (input.rendererOwnsSetup && input.agentLaunchMode !== 'structured') {
    result.setup = prepared?.setup
    return result
  }
  if (result.agentLaunchOutcome?.status === 'failed') {
    return result
  }
  const pendingDraft =
    input.startupCommand &&
    input.startupAgent &&
    input.startupPrompt &&
    input.startupPromptDelivery === 'draft'
      ? { agent: input.startupAgent, content: input.startupPrompt }
      : undefined
  const pendingFollowup =
    input.startupCommand &&
    input.startupAgent &&
    input.startupPrompt &&
    input.startupPromptDelivery === 'auto-submit'
      ? { agent: input.startupAgent, prompt: input.startupPrompt }
      : undefined
  const deferInput = required && Boolean(pendingDraft || pendingFollowup)
  const captured: { terminal?: RuntimeTerminalCreate } = {}
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
    observeSetupCompletion: input.agentLaunchMode === 'structured' || deferInput,
    onStartupTerminalCreated: (terminal: RuntimeTerminalCreate) => {
      captured.terminal = terminal
      input.onStartupTerminalCreated?.(terminal)
    },
    setupOnly: input.agentLaunchMode === 'structured'
  }
  const built = await resolveWorktreeCreateAgentStartup(request, args.buildStartup)
  const started = await startRuntimeLocalWorktreeTerminals({
    request,
    repo: { id: group.id },
    worktree: folderWorkspaceToWorktree(workspace),
    setup: prepared?.setup,
    startup: request.startup ?? built?.startup,
    startupFollowup: deferInput ? undefined : (pendingFollowup ?? built?.followup),
    draftPaste: deferInput ? undefined : pendingDraft,
    observeSequencedSetupCompletion: deferInput,
    ...(pendingDraft || pendingFollowup ? { guardStartupInput: true as const } : {}),
    startupLaunchRuntime: built?.launchRuntime,
    createdWithAgent: input.createdWithAgent,
    promisedAgentChat: input.agentLaunchMode === 'structured',
    ports: args.ports
  })
  if (deferInput && started.didSpawnStartup && captured.terminal) {
    const terminal = captured.terminal
    // The host owns pending input after create returns; RPC disconnect is not cancellation.
    void groupSetupAgentOutcome({
      required: true,
      prepared: Boolean(prepared?.setup),
      terminalHandle: started.setupTerminalHandle,
      wait: args.wait,
      timeoutMs: SETUP_AGENT_WAIT_TIMEOUT_SECONDS * 1000
    })
      .then((outcome) => {
        if (outcome.status !== 'successful') {
          return
        }
        if (pendingDraft) {
          args.ports.pasteDraft(terminal.handle, pendingDraft, terminal)
        } else if (pendingFollowup) {
          args.ports.sendFollowup(terminal.handle, pendingFollowup, terminal, true)
        }
      })
      .catch((error) => console.warn('[hooks] group startup input was not delivered:', error))
  }
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
    result.agentLaunchOutcome = await groupSetupAgentOutcome({
      required,
      prepared: Boolean(prepared?.setup),
      terminalHandle: started.setupTerminalHandle,
      wait: args.wait,
      signal: input.signal
    })
  }
  return result
}
