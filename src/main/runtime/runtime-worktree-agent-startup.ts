import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import { tuiAgentToAgentKind } from '../../shared/agent-kind'
import type { Repo } from '../../shared/repo-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import { launchSourceSchema } from '../../shared/telemetry-property-schemas'
import { repoIsRemote } from '../../shared/agent-launch-remote'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { isTuiAgentEnabled, pickTuiAgent } from '../../shared/tui-agent-selection'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import {
  markAntigravityWorkspaceTrusted,
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted
} from '../agent-trust-presets'
import {
  detectInstalledAgentsWithShellPathHydration,
  detectRemoteAgents
} from '../preflight/agent-detection'
import { markRemoteAgentWorkspaceTrusted } from '../remote-agent-trust-presets'
import type { RuntimeStore } from './runtime-store-contract'

export type WorktreeStartupDraftPaste = { agent: TuiAgent; content: string }
export type WorktreeStartupFollowup = { expectedProcess: string; prompt: string }

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
  startup: WorktreeStartupLaunch
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
        ...(draftPlan.env ? { env: draftPlan.env } : {})
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
      ...(startupPlan.env ? { env: startupPlan.env } : {})
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
  }
): { agent: TuiAgent; startup: WorktreeStartupLaunch; followup?: WorktreeStartupFollowup } {
  const { agent, repo, settings } = environment
  if (!isTuiAgentEnabled(agent, settings.disabledTuiAgents)) {
    throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
  }
  const startupPlan = buildAgentStartupPlan({
    ...resolveAgentStartupPlanInputs({
      agent,
      settings,
      platform: environment.getLaunchPlatform(),
      isRemote: repoIsRemote(repo),
      ...(environment.agentArgs !== undefined ? { agentArgs: environment.agentArgs } : {}),
      sessionOptions: environment.toSessionOptions(environment.launchPreferences)
    }),
    prompt: environment.prompt ?? '',
    allowEmptyPromptLaunch: true
  })
  if (!startupPlan) {
    throw new Error(`Could not build launch command for ${agent}.`)
  }
  const telemetry = agentLaunchTelemetry(agent, environment.launchSource)
  return {
    agent,
    startup: {
      command: startupPlan.launchCommand,
      launchConfig: startupPlan.launchConfig,
      ...(startupPlan.startupCommandDelivery
        ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
        : {}),
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      ...(telemetry ? { telemetry } : {})
    },
    ...(startupPlan.followupPrompt
      ? {
          followup: {
            expectedProcess: startupPlan.expectedProcess,
            prompt: startupPlan.followupPrompt
          }
        }
      : {})
  }
}

function agentLaunchTelemetry(
  agent: TuiAgent,
  launchSource: string | undefined
): WorktreeStartupLaunch['telemetry'] | undefined {
  const parsed = launchSourceSchema.safeParse(launchSource)
  return parsed.success
    ? {
        agent_kind: tuiAgentToAgentKind(agent),
        launch_source: parsed.data,
        request_kind: 'new'
      }
    : undefined
}

export async function markLocalWorktreeTrusted(
  agent: TuiAgent,
  workspacePath: string
): Promise<void> {
  const preset = TUI_AGENT_CONFIG[agent].preflightTrust
  if (!preset) {
    return
  }
  try {
    if (preset === 'cursor') {
      markCursorWorkspaceTrusted(workspacePath)
    } else if (preset === 'copilot') {
      markCopilotFolderTrusted(workspacePath)
    } else if (preset === 'codex') {
      // Why: the Codex write queues behind any in-flight hook grant, so the agent must not launch until it lands.
      await markCodexProjectTrusted(workspacePath)
    } else if (preset === 'antigravity') {
      markAntigravityWorkspaceTrusted(workspacePath)
    }
  } catch {
    // Best-effort: the user can still accept the agent trust prompt manually.
  }
}

export async function markRemoteWorktreeTrusted(
  agent: TuiAgent,
  connectionId: string,
  workspacePath: string
): Promise<void> {
  const preset = TUI_AGENT_CONFIG[agent].preflightTrust
  if (!preset) {
    return
  }
  try {
    await markRemoteAgentWorkspaceTrusted({ preset, connectionId, workspacePath })
  } catch {
    // Best-effort: the user can still accept the remote agent trust prompt manually.
  }
}
