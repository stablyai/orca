import { OrcaRuntimeWithListManagedWorktrees } from '../managed-workspace-operations'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import {
  buildWorktreeStartupForAgent,
  buildWorktreeStartupForDraft,
  resolveWorktreeStartupDraftAgent
} from '../../runtime-worktree-agent-startup'

export abstract class OrcaRuntimeWithBuildWorktreeStartup extends OrcaRuntimeWithListManagedWorktrees {
  protected abstract toAgentSessionOptions(
    preferences: AgentLaunchPreferences | undefined
  ): Record<string, string> | undefined

  /** Use buildStartupForDraft's selection so launches can name the agent before creation. */
  async resolveStartupDraftAgent(repo: Repo, requestedAgent?: TuiAgent): Promise<TuiAgent | null> {
    if (!this.store) {
      return null
    }
    return resolveWorktreeStartupDraftAgent({
      repo,
      settings: this.store.getSettings(),
      ...(requestedAgent ? { requestedAgent } : {})
    })
  }

  protected async buildStartupForDraft(
    repo: Repo,
    draft: string,
    requestedAgent?: TuiAgent,
    launchSource?: string
  ): ReturnType<typeof buildWorktreeStartupForDraft> {
    if (!this.store) {
      return null
    }
    return buildWorktreeStartupForDraft({
      repo,
      draft,
      ...(requestedAgent ? { requestedAgent } : {}),
      ...(launchSource ? { launchSource } : {}),
      settings: this.store.getSettings(),
      getLaunchRuntime: (agent) => this.resolveStartupAgentLaunchRuntime(repo, agent)
    })
  }

  protected buildStartupForAgent(
    repo: Repo,
    agent: TuiAgent,
    prompt: string | undefined,
    launchPreferences?: AgentLaunchPreferences,
    launchInputs?: {
      agentArgs?: string | null
      extraAgentArgs?: string
      suppressStartupUpdatePrompt?: boolean
      launchSource?: string
      onPromptCarry?: (carried: boolean) => void
      /** The existing workspace it starts in; absent is a new workspace of `repo`. */
      launchScope?: TerminalWorkspaceLaunchScope
    }
  ): ReturnType<typeof buildWorktreeStartupForAgent> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return buildWorktreeStartupForAgent({
      repo,
      agent,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(launchPreferences ? { launchPreferences } : {}),
      ...(launchInputs?.agentArgs !== undefined ? { agentArgs: launchInputs.agentArgs } : {}),
      ...(launchInputs?.extraAgentArgs ? { extraAgentArgs: launchInputs.extraAgentArgs } : {}),
      ...(launchInputs?.suppressStartupUpdatePrompt ? { suppressStartupUpdatePrompt: true } : {}),
      ...(launchInputs?.launchSource ? { launchSource: launchInputs.launchSource } : {}),
      ...(launchInputs?.onPromptCarry ? { onPromptCarry: launchInputs.onPromptCarry } : {}),
      settings: this.store.getSettings(),
      getLaunchRuntime: (agent) =>
        this.resolveStartupAgentLaunchRuntime(repo, agent, launchInputs?.launchScope),
      toSessionOptions: (preferences) => this.toAgentSessionOptions(preferences)
    })
  }
}
