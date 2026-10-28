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
import type { AgentLaunchRuntime } from '../../shared/agent-launch-runtime'
import type { resolveStartupAgentLaunchRuntime } from './agent-launch-scope-runtime'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import { planStartupWithPromptCandidate } from '../../shared/startup-line-prompt-carry'
import {
  launchHostProvesAgentInFront,
  nameLocalTypedLineShell
} from './agent-launch-typed-line-shell'
import { detectAgentsOnHost } from '../preflight/workspace-agent-detection'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'

export type WorktreeStartupDraftPaste = { agent: TuiAgent; content: string }
export type WorktreeStartupFollowup = { agent: TuiAgent; prompt: string }

/** Require agent_started attribution on every host-built fresh launch. */
type AttributedWorktreeStartupLaunch = WorktreeStartupLaunch & {
  telemetry: NonNullable<WorktreeStartupLaunch['telemetry']>
}

type StartupEnvironment = {
  repo: Repo
  settings: ReturnType<RuntimeStore['getSettings']>
  /** Resolve the execution host's quoting/spawn fact, or the repair error that refuses startup. */
  getLaunchRuntime: (agent: TuiAgent) => ReturnType<typeof resolveStartupAgentLaunchRuntime>
  /** Replaces the configured arguments for this launch; `null` means none. */
  agentArgs?: string | null
  /** An automation's saved extras, merged over the launch's arguments. */
  extraAgentArgs?: string
  /** Orca, not a user, types into this agent once it starts. */
  suppressStartupUpdatePrompt?: boolean
  /** Caller-supplied telemetry attribution, validated leniently at the host boundary. */
  launchSource?: string
}

/** Choose requested, default or execution-host-detected agent; null means no agent. */
export async function resolveWorktreeStartupDraftAgent(
  environment: Pick<StartupEnvironment, 'repo' | 'settings'> & { requestedAgent?: TuiAgent }
): Promise<TuiAgent | null> {
  const { repo, settings } = environment
  const preferredAgent = environment.requestedAgent ?? settings.defaultTuiAgent
  // Blank explicitly requests a shell; linked drafts must not auto-pick an agent.
  if (preferredAgent === 'blank') {
    return null
  }
  if (isTuiAgent(preferredAgent) && isTuiAgentEnabled(preferredAgent, settings.disabledTuiAgents)) {
    return preferredAgent
  }
  let detected: string[] = []
  // Detect on the execution host; raw connectionId misses executionHostId-only SSH repos.
  const sshConnectionId = getRepoSshConnectionId(repo)
  try {
    // Sparse launch environments may lack host detection dependencies.
    detected = await detectAgentsOnHost(
      sshConnectionId ? { kind: 'ssh', connectionId: sshConnectionId } : { kind: 'local' }
    )
  } catch {
    detected = []
  }
  return pickTuiAgent(null, detected.filter(isTuiAgent), settings.disabledTuiAgents)
}

export async function buildWorktreeStartupForDraft(
  environment: StartupEnvironment & { draft: string; requestedAgent?: TuiAgent }
): Promise<{
  agent: TuiAgent
  startup: AttributedWorktreeStartupLaunch
  draftPaste?: WorktreeStartupDraftPaste
  launchRuntime: AgentLaunchRuntime | Error
} | null> {
  const content = environment.draft.trim()
  if (!content) {
    return null
  }
  const { repo, settings } = environment
  const agent = await resolveWorktreeStartupDraftAgent(environment)
  if (!agent) {
    return null
  }

  const { platform, shell, launchRuntime } = environment.getLaunchRuntime(agent)
  const launchArgs = resolveAgentStartupPlanInputs({
    agent,
    settings,
    platform,
    shell,
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
      },
      launchRuntime
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
    draftPaste: { agent, content },
    launchRuntime
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
    /** Caller delivers any uncarried prompt; report typed-line carry. Absent preserves CLI behavior. */
    onPromptCarry?: (carried: boolean) => void
  }
): {
  agent: TuiAgent
  startup: AttributedWorktreeStartupLaunch
  followup?: WorktreeStartupFollowup
  launchRuntime: AgentLaunchRuntime | Error
} {
  const { agent, repo, settings } = environment
  if (!isTuiAgentEnabled(agent, settings.disabledTuiAgents)) {
    throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
  }
  const { platform, shell, launchRuntime } = environment.getLaunchRuntime(agent)
  const planInputs = resolveAgentStartupPlanInputs({
    agent,
    settings,
    platform,
    shell,
    isRemote: repoIsRemote(repo),
    ...(environment.agentArgs !== undefined ? { agentArgs: environment.agentArgs } : {}),
    ...(environment.extraAgentArgs ? { extraAgentArgs: environment.extraAgentArgs } : {}),
    ...(environment.suppressStartupUpdatePrompt ? { suppressStartupUpdatePrompt: true } : {}),
    sessionOptions: environment.toSessionOptions(environment.launchPreferences)
  })
  const prompt = environment.prompt ?? ''
  let startupPlan: ReturnType<typeof buildAgentStartupPlan>
  if (environment.onPromptCarry) {
    const offered = planStartupWithPromptCandidate(planInputs, prompt, {
      shellName: nameLocalTypedLineShell({
        isRemote: repoIsRemote(repo),
        ...(!(launchRuntime instanceof Error) && launchRuntime.pty.shellOverride
          ? { shellOverride: launchRuntime.pty.shellOverride }
          : {})
      }),
      provesAgentInFront: launchHostProvesAgentInFront({
        isRemote: repoIsRemote(repo),
        launchPlatform: platform
      })
    })
    startupPlan = offered.plan
    if (startupPlan && prompt.trim()) {
      environment.onPromptCarry(offered.promptCarried)
    }
  } else {
    startupPlan = buildAgentStartupPlan({ ...planInputs, prompt, allowEmptyPromptLaunch: true })
  }
  if (!startupPlan) {
    throw new Error(`Could not build launch command for ${agent}.`)
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
      telemetry: agentStartedTelemetry(agent, environment.launchSource)
    },
    launchRuntime,
    ...(startupPlan.followupPrompt
      ? {
          followup: { agent, prompt: startupPlan.followupPrompt }
        }
      : {})
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
      extraAgentArgs?: string
      suppressStartupUpdatePrompt?: boolean
      launchSource?: string
      onPromptCarry?: (carried: boolean) => void
    }
  ) => {
    agent: TuiAgent
    startup: WorktreeStartupLaunch
    followup?: WorktreeStartupFollowup
    launchRuntime: AgentLaunchRuntime | Error
  }
) {
  if (args.startup || !args.startupAgent) {
    return null
  }
  const built = build(args.startupAgent, args.startupPrompt, args.startupLaunchPreferences, {
    ...(args.startupAgentArgs !== undefined ? { agentArgs: args.startupAgentArgs } : {}),
    ...(args.startupExtraAgentArgs ? { extraAgentArgs: args.startupExtraAgentArgs } : {}),
    ...(args.startupSuppressUpdatePrompt ? { suppressStartupUpdatePrompt: true } : {}),
    ...(args.startupLaunchSource ? { launchSource: args.startupLaunchSource } : {}),
    ...(args.onStartupPromptCarry ? { onPromptCarry: args.onStartupPromptCarry } : {})
  })
  return args.startupAccountEnv
    ? {
        ...built,
        startup: { ...built.startup, env: { ...built.startup.env, ...args.startupAccountEnv } }
      }
    : built
}
