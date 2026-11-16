import { resolveManagedWorktreeCreateStartup } from '../startup/managed-worktree-create-startup'
import { startRuntimeLocalWorktreeTerminals } from '../startup/runtime-local-worktree-terminal-startup'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import { OrcaRuntimeWithGetWorktreeTerminalProvisioningHost } from '../startup/workspace-terminal-provisioning'
import {
  prepareGroupFolderCreation,
  groupFolderCreationIsUserAct,
  type RuntimeGroupFolderCreateInput
} from './runtime-group-folder-setup'
import type { ProjectGroup } from '../../../../shared/project/groups/project-group-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { RuntimeNavigationTarget } from '../../../../shared/remote-runtime/session-graph/runtime-navigation'
import type { RuntimeLocalWorktreeTerminalPorts } from '../startup/runtime-local-worktree-terminal-startup'
import { wslUserAct } from '../startup/workspace-create-activation'
import {
  buildWorktreeStartupForAgent,
  buildWorktreeStartupForDraft
} from '../startup/runtime-worktree-agent-startup'
import { resolveStartupAgentLaunchRuntime } from '../../terminal/launch/agent-launch-scope-runtime'
import { projectGroupHookOwner } from '../../../../shared/workspace-setup/hooks/workspace-hook-owner'

export abstract class OrcaRuntimeWithGroupFolderSetup extends OrcaRuntimeWithGetWorktreeTerminalProvisioningHost {
  async startCreatedWorktreeTerminals(args: {
    request: RuntimeManagedWorktreeCreateArgs
    repo: Repo
    worktree: Worktree
    setup?: CreateWorktreeResult['setup']
    defaultTabs?: CreateWorktreeResult['defaultTabs']
    setupPreparationFailure?: Error
  }) {
    const { request, repo, worktree } = args
    const built = await resolveManagedWorktreeCreateStartup(
      request,
      this.requireStore().getSettings().disabledTuiAgents,
      {
        agent: (agent, prompt, preferences, inputs) =>
          this.buildStartupForAgent(repo, agent, prompt, preferences, inputs),
        draft: (draft, agent, source, inputs) =>
          this.buildStartupForDraft(repo, draft, agent, source, inputs)
      }
    )
    if (args.setupPreparationFailure) {
      this.setupTerminalCompletions.refuseWorkspace(worktree.id)
    }
    return startRuntimeLocalWorktreeTerminals({
      request,
      repo,
      worktree,
      setup: args.setup,
      requiredSetup: Boolean(args.setupPreparationFailure) || args.setup?.waitForAgentStartup,
      defaultTabs: args.defaultTabs,
      startup: built.effectiveStartup,
      startupFollowup: built.effectiveStartupFollowup,
      startupLaunchRuntime: args.setupPreparationFailure ?? built.startupLaunchRuntime,
      draftPaste: built.effectiveDraftPaste,
      createdWithAgent: built.effectiveCreatedWithAgent,
      promisedAgentChat: request.promisedAgentChat,
      ports: this.localWorktreeTerminalPorts(request, () => {}, worktree)
    })
  }

  protected finishGroupFolderCreation = async (
    input: RuntimeGroupFolderCreateInput,
    group: ProjectGroup,
    workspace: FolderWorkspace
  ) => {
    const store = this.requireStore()
    const worktree = this.folderWorkspaceToResolvedWorktree(workspace)
    this.beginWorkspaceSetup(worktree.id)
    const activation: { wslUserAct?: true } = groupFolderCreationIsUserAct(input)
      ? { wslUserAct: true }
      : {}
    try {
      const scope = await this.resolveTerminalWorkspaceLaunchScope(
        `id:${worktree.id}`,
        undefined,
        activation,
        worktree,
        workspace
      )
      const owner = projectGroupHookOwner(group)
      return await prepareGroupFolderCreation({
        input,
        group,
        workspace,
        settings: store.getSettings(),
        ports: this.localWorktreeTerminalPorts(activation, () => {}, worktree),
        startupBuilders: {
          agent: (agent, prompt, launchPreferences, inputs) =>
            buildWorktreeStartupForAgent({
              repo: owner ?? {
                path: workspace.folderPath,
                connectionId: workspace.connectionId,
                executionHostId: workspace.executionHostId
              },
              agent,
              prompt,
              launchPreferences,
              ...inputs,
              settings: store.getSettings(),
              getLaunchRuntime: (requested) =>
                resolveStartupAgentLaunchRuntime(store, scope, requested),
              toSessionOptions: (preferences) => this.toAgentSessionOptions(preferences)
            }),
          draft: (draft, requestedAgent, launchSource, inputs) =>
            buildWorktreeStartupForDraft({
              repo: owner ?? {
                path: workspace.folderPath,
                connectionId: workspace.connectionId,
                executionHostId: workspace.executionHostId
              },
              draft,
              requestedAgent,
              originalAgent: inputs?.createdWithAgent ?? requestedAgent,
              agentArgs: inputs?.startupAgentArgs,
              sessionOptions:
                inputs?.startupSessionOptions ??
                this.toAgentSessionOptions(inputs?.startupLaunchPreferences),
              launchSource,
              settings: store.getSettings(),
              getLaunchRuntime: (agent) => resolveStartupAgentLaunchRuntime(store, scope, agent)
            })
        }
      })
    } catch (error) {
      this.refuseWorkspaceSetup(worktree.id)
      throw error
    }
  }
  protected localWorktreeTerminalPorts(
    args: { navigation?: RuntimeNavigationTarget; wslUserAct?: true },
    activate: RuntimeLocalWorktreeTerminalPorts['activate'],
    worktree?: Worktree
  ): RuntimeLocalWorktreeTerminalPorts {
    return {
      bindSetupRecipe: (id, recipe) => this.setupTerminalCompletions.bindRecipe(id, recipe),
      canSpawn: Boolean(this.ptyController?.spawn),
      setupPrepared: (workspaceId, required, inProcess) =>
        this.preparedWorkspaceSetup(workspaceId, required, inProcess),
      setupFailed: (workspaceId) => this.setupTerminalCompletions.refuseWorkspace(workspaceId),
      waitForSetupTerminalCompletion: (handle, signal) =>
        this.waitForSetupTerminalCompletion(handle, signal),
      provisionInBackground: () => this.shouldProvisionWorktreeInBackground(args.navigation),
      createTerminal: (selector, options) =>
        worktree
          ? this.createTerminal(selector, { ...options, ...wslUserAct(args) }, worktree)
          : this.createTerminal(selector, { ...options, ...wslUserAct(args) }),
      pasteDraft: (handle, draft) => this.pasteStartupDraftWhenReady(handle, draft),
      sendFollowup: (handle, followup, terminal) => {
        void this.deliverStartupFollowup(handle, followup, { terminalCreation: terminal })
      },
      provision: (options) =>
        this.provisionManagedWorktreeTerminals({ ...options, ...wslUserAct(args) }, worktree),
      activate
    }
  }
}
