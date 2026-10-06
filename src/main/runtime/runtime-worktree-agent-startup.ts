import { agentStartedTelemetry } from '../agent-launch/agent-started-telemetry'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import type { Repo } from '../../shared/repo-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import { repoIsRemote } from '../../shared/agent-launch-remote'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { isTuiAgentEnabled, pickTuiAgent } from '../../shared/tui-agent-selection'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  planLaunchPrompt,
  type AgentStartupPlan
} from '../../shared/tui-agent-startup'
import type { LaunchFile } from '../../shared/launch-prompt-file'
import { thisOrcaLaunchHost } from './this-orca-launch-host'
import {
  detectInstalledAgentsWithShellPathHydration,
  detectRemoteAgents
} from '../preflight/agent-detection'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'

export type WorktreeStartupDraftPaste = { agent: TuiAgent; content: string }
export type WorktreeStartupFollowup = { expectedProcess: string; prompt: string }

/** A fresh agent the host builds always carries its `agent_started` record; dropping it fails to compile. */
type AttributedWorktreeStartupLaunch = WorktreeStartupLaunch & {
  telemetry: NonNullable<WorktreeStartupLaunch['telemetry']>
}

type StartupEnvironment = {
  repo: Repo
  settings: ReturnType<RuntimeStore['getSettings']>
  getLaunchPlatform: () => NodeJS.Platform
  /** Replaces the configured arguments for this launch; `null` means none. */
  agentArgs?: string | null
  /** Caller-supplied telemetry attribution, validated leniently at the host boundary. */
  launchSource?: string
}

export async function buildWorktreeStartupForDraft(
  environment: StartupEnvironment & { draft: string; requestedAgent?: TuiAgent }
): Promise<{
  agent: TuiAgent
  startup: AttributedWorktreeStartupLaunch
  draftPaste?: WorktreeStartupDraftPaste
} | null> {
  const content = environment.draft.trim()
  if (!content) {
    return null
  }
  const { repo, settings } = environment
  const preferredAgent = environment.requestedAgent ?? settings.defaultTuiAgent
  // Why: `blank` is an explicit shell-only preference, so linked drafts must not auto-pick an agent.
  if (preferredAgent === 'blank') {
    return null
  }
  let agent =
    isTuiAgent(preferredAgent) && isTuiAgentEnabled(preferredAgent, settings.disabledTuiAgents)
      ? preferredAgent
      : null
  if (!agent) {
    let detected: string[] = []
    // Why: detection has to run on the machine that will run the agent, and SSH ownership has two
    // spellings — the raw field probes this client for an `executionHostId: 'ssh:*'`-only repo.
    const sshConnectionId = getRepoSshConnectionId(repo)
    try {
      // Why: startup-draft fallback can run from sparse runtime launch envs too.
      detected = sshConnectionId
        ? await detectRemoteAgents({ connectionId: sshConnectionId })
        : await detectInstalledAgentsWithShellPathHydration()
    } catch {
      detected = []
    }
    agent = pickTuiAgent(null, detected.filter(isTuiAgent), settings.disabledTuiAgents)
  }
  if (!agent) {
    return null
  }

  const launchArgs = resolveAgentStartupPlanInputs({
    agent,
    settings,
    platform: environment.getLaunchPlatform(),
    isRemote: repoIsRemote(repo),
    ...(environment.agentArgs !== undefined ? { agentArgs: environment.agentArgs } : {})
  })
  const telemetry = agentStartedTelemetry(agent, environment.launchSource)
  const draftPlan = buildAgentDraftLaunchPlan({ ...launchArgs, draft: content })
  if (draftPlan) {
    return {
      agent,
      startup: {
        command: draftPlan.launchCommand,
        launchConfig: draftPlan.launchConfig,
        ...(draftPlan.startupCommandDelivery
          ? { startupCommandDelivery: draftPlan.startupCommandDelivery }
          : {}),
        ...(draftPlan.env ? { env: draftPlan.env } : {}),
        telemetry
      }
    }
  }
  const startupPlan = buildAgentStartupPlan({
    ...launchArgs,
    prompt: '',
    allowEmptyPromptLaunch: true
  })
  if (!startupPlan) {
    return null
  }
  return {
    agent,
    startup: {
      command: startupPlan.launchCommand,
      launchConfig: startupPlan.launchConfig,
      ...(startupPlan.startupCommandDelivery
        ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
        : {}),
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      telemetry
    },
    draftPaste: { agent, content }
  }
}

export function buildWorktreeStartupForAgent(
  environment: StartupEnvironment & {
    agent: TuiAgent
    prompt?: string
    launchPreferences?: AgentLaunchPreferences
    toSessionOptions: (
      preferences?: AgentLaunchPreferences
    ) => Parameters<typeof buildAgentStartupPlan>[0]['sessionOptions'] | undefined
    /** Set by a caller that pastes an uncarried prompt itself; reports whether it rode the command,
     *  and no follow-up is returned for it to paste twice. */
    onPromptCarry?: (carried: boolean) => void
  }
): {
  agent: TuiAgent
  startup: AttributedWorktreeStartupLaunch
  followup?: WorktreeStartupFollowup
} {
  const { agent, repo, settings } = environment
  if (!isTuiAgentEnabled(agent, settings.disabledTuiAgents)) {
    throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
  }
  const planInputs = resolveAgentStartupPlanInputs({
    agent,
    settings,
    platform: environment.getLaunchPlatform(),
    isRemote: repoIsRemote(repo),
    ...(environment.agentArgs !== undefined ? { agentArgs: environment.agentArgs } : {}),
    sessionOptions: environment.toSessionOptions(environment.launchPreferences)
  })
  const planned = planLaunchPrompt({
    ...planInputs,
    prompt: environment.prompt ?? '',
    host: thisOrcaLaunchHost({
      isRemote: repoIsRemote(repo),
      launchPlatform: environment.getLaunchPlatform(),
      settings,
      workspacePath: repo.path
    }),
    // The caller, or else the host's follow-up, pastes what the line leaves once the agent runs.
    paste: 'when-host-proves-agent'
  })
  if (!planned) {
    throw new Error(`Could not build launch command for ${agent}.`)
  }
  let startupPlan: AgentStartupPlan
  let launchFile: LaunchFile | undefined
  let followup: WorktreeStartupFollowup | undefined
  switch (planned.carry) {
    case 'none':
      startupPlan = planned.plan
      break
    case 'on-line':
    case 'launch-file':
      startupPlan = planned.plan
      launchFile = planned.carry === 'launch-file' ? planned.launchFile : undefined
      environment.onPromptCarry?.(true)
      break
    case 'paste-after-ready':
      startupPlan = planned.cleanPlan
      if (environment.onPromptCarry) {
        environment.onPromptCarry(false)
      } else {
        followup = { expectedProcess: startupPlan.expectedProcess, prompt: planned.text }
      }
      break
  }
  return {
    agent,
    startup: {
      command: startupPlan.launchCommand,
      launchConfig: startupPlan.launchConfig,
      ...(startupPlan.startupCommandDelivery
        ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
        : {}),
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      ...(launchFile ? { launchFile } : {}),
      telemetry: agentStartedTelemetry(agent, environment.launchSource)
    },
    ...(followup ? { followup } : {})
  }
}

export function resolveWorktreeCreateAgentStartup(
  args: RuntimeManagedWorktreeCreateArgs,
  build: (
    agent: TuiAgent,
    prompt: string | undefined,
    preferences: AgentLaunchPreferences | undefined,
    inputs: {
      agentArgs?: string | null
      launchSource?: string
      onPromptCarry?: (carried: boolean) => void
    }
  ) => Promise<{
    agent: TuiAgent
    startup: WorktreeStartupLaunch
    followup?: WorktreeStartupFollowup
  }>
) {
  if (args.startup || !args.startupAgent) {
    return null
  }
  return build(args.startupAgent, args.startupPrompt, args.startupLaunchPreferences, {
    ...(args.startupAgentArgs !== undefined ? { agentArgs: args.startupAgentArgs } : {}),
    ...(args.startupLaunchSource ? { launchSource: args.startupLaunchSource } : {}),
    ...(args.onStartupPromptCarry ? { onPromptCarry: args.onStartupPromptCarry } : {})
  })
}
