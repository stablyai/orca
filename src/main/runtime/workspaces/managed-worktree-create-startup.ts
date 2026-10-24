import { applyRemoteViewerLaunchEnv } from '../remote-viewer-launch-env'
import type { RuntimeManagedWorktreeCreateArgs } from '../runtime-managed-worktree-create-types'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  type buildWorktreeStartupForDraft,
  resolveWorktreeCreateAgentStartup
} from '../runtime-worktree-agent-startup'

type StartupBuilders = {
  agent: Parameters<typeof resolveWorktreeCreateAgentStartup>[1]
  draft: (
    draft: string,
    requestedAgent?: TuiAgent,
    launchSource?: string
  ) => ReturnType<typeof buildWorktreeStartupForDraft>
}

/** What the new workspace's first terminal launches, refusing a disabled agent. */
export async function resolveManagedWorktreeCreateStartup(
  args: RuntimeManagedWorktreeCreateArgs,
  disabledTuiAgents: Parameters<typeof isTuiAgentEnabled>[1],
  build: StartupBuilders
) {
  const requestedAgent = args.startupAgent ?? args.createdWithAgent
  const requestedAgentEnabled =
    requestedAgent !== undefined ? isTuiAgentEnabled(requestedAgent, disabledTuiAgents) : false
  if ((args.startup || args.startupAgent) && requestedAgent && !requestedAgentEnabled) {
    throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
  }
  if (
    args.startup &&
    args.startupDraftPaste &&
    !isTuiAgentEnabled(args.startupDraftPaste.agent, disabledTuiAgents)
  ) {
    throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
  }
  const agentStartup = resolveWorktreeCreateAgentStartup(args, build.agent)
  const draftStartup =
    !args.startup && !agentStartup && args.startupDraft
      ? await build.draft(
          args.startupDraft,
          args.startupDraftAgent ?? requestedAgent,
          args.startupLaunchSource
        )
      : null
  const resolvedStartup = args.startup ?? agentStartup?.startup ?? draftStartup?.startup
  const effectiveStartup = resolvedStartup
    ? applyRemoteViewerLaunchEnv(
        resolvedStartup,
        args.terminalImageViewerSupported,
        resolvedStartup.launchAgent ??
          args.startupAgent ??
          args.createdWithAgent ??
          agentStartup?.agent ??
          draftStartup?.agent
      )
    : undefined
  const effectiveStartupFollowup = agentStartup?.followup
  const startupLaunchRuntime = args.startup
    ? undefined
    : (agentStartup ?? draftStartup)?.launchRuntime
  const effectiveCreatedWithAgent = args.startup
    ? args.createdWithAgent
    : (agentStartup?.agent ??
      draftStartup?.agent ??
      (requestedAgentEnabled ? requestedAgent : undefined))
  const effectiveDraftPaste = args.startupDraftPaste ?? draftStartup?.draftPaste
  return {
    effectiveStartup,
    effectiveStartupFollowup,
    startupLaunchRuntime,
    effectiveCreatedWithAgent,
    effectiveDraftPaste
  }
}
