import { OrcaRuntimeWithGetWorktreeTerminalProvisioningHost } from '../startup/workspace-terminal-provisioning'
import {
  prepareGroupFolderCreation,
  groupFolderCreationIsUserAct,
  type RuntimeGroupFolderCreateInput
} from './runtime-group-folder-setup'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { RuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import type { RuntimeLocalWorktreeTerminalPorts } from '../startup/runtime-local-worktree-terminal-startup'
import { wslUserAct } from '../startup/workspace-create-activation'
import { buildWorktreeStartupForAgent } from '../startup/runtime-worktree-agent-startup'
import { resolveStartupAgentLaunchRuntime } from '../../terminal/launch/agent-launch-scope-runtime'
import { createLaunchedAgentWriteGuard } from '../../terminal/wait/launched-agent-write-guard'
import { pasteWorktreeStartupDraftWhenReady } from '../startup/runtime-worktree-startup-readiness'
import { deliverGroupFolderStartupFollowup } from './runtime-group-folder-followup'
import { projectGroupHookOwner } from '../../../../shared/workspace-hook-owner'

export abstract class OrcaRuntimeWithGroupFolderSetup extends OrcaRuntimeWithGetWorktreeTerminalProvisioningHost {
  protected finishGroupFolderCreation = async (
    input: RuntimeGroupFolderCreateInput,
    group: ProjectGroup,
    workspace: FolderWorkspace
  ) => {
    const store = this.requireStore()
    const worktree = this.folderWorkspaceToResolvedWorktree(workspace)
    const activation: { wslUserAct?: true } = groupFolderCreationIsUserAct(input)
      ? { wslUserAct: true }
      : {}
    const scope = await this.resolveTerminalWorkspaceLaunchScope(
      `id:${worktree.id}`,
      undefined,
      activation,
      worktree,
      workspace
    )
    const owner = projectGroupHookOwner(group)
    return prepareGroupFolderCreation({
      input,
      group,
      workspace,
      settings: store.getSettings(),
      ports: this.localWorktreeTerminalPorts(activation, () => {}, worktree),
      wait: (handle, signal) => this.waitForSetupTerminalCompletion(handle, signal),
      buildStartup: (agent, prompt, launchPreferences, inputs) =>
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
        })
    })
  }
  private assertGroupStartupInputTarget(target: RuntimeTerminalCreate, ptyId: string): void {
    const live = this.getLivePtyForHandle(target.handle)?.pty
    if (
      !target.ptyId ||
      target.ptyId !== ptyId ||
      live?.ptyId !== target.ptyId ||
      (target.incarnationId && live.incarnationId !== target.incarnationId)
    ) {
      throw new Error('terminal_handle_stale')
    }
  }
  protected localWorktreeTerminalPorts(
    args: { navigation?: RuntimeNavigationTarget; wslUserAct?: true },
    activate: RuntimeLocalWorktreeTerminalPorts['activate'],
    worktree?: Worktree
  ): RuntimeLocalWorktreeTerminalPorts {
    return {
      canSpawn: Boolean(this.ptyController?.spawn),
      provisionInBackground: () => this.shouldProvisionWorktreeInBackground(args.navigation),
      createTerminal: (selector, options) =>
        worktree
          ? this.createTerminal(selector, { ...options, ...wslUserAct(args) }, worktree)
          : this.createTerminal(selector, { ...options, ...wslUserAct(args) }),
      pasteDraft: (handle, draft, target) => {
        if (!target) {
          this.pasteStartupDraftWhenReady(handle, draft)
          return
        }
        const guard = createLaunchedAgentWriteGuard(this, draft.agent, {
          unprovableHost: 'write-unless-shell'
        })
        pasteWorktreeStartupDraftWhenReady(this.getWorktreeStartupReadinessHost(), handle, draft, {
          beforeWrite: async (ptyId) => {
            await guard.beforeWrite(ptyId)
            this.assertGroupStartupInputTarget(target, ptyId)
          },
          dispose: guard.dispose
        })
      },
      sendFollowup: (handle, followup, terminal, guardTarget) => {
        if (!guardTarget) {
          void this.deliverStartupFollowup(handle, followup, { terminalCreation: terminal })
          return
        }
        void deliverGroupFolderStartupFollowup({
          runtime: this,
          host: this.getWorktreeStartupReadinessHost(),
          terminal,
          followup,
          beforeWrite: (ptyId) => this.assertGroupStartupInputTarget(terminal, ptyId)
        })
      },
      provision: (options) =>
        this.provisionManagedWorktreeTerminals({ ...options, ...wslUserAct(args) }, worktree),
      activate
    }
  }
}
