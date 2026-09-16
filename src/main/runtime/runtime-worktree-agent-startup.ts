import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import type { Repo } from '../../shared/repo-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import { repoIsRemote } from '../../shared/agent-launch-remote'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { isTuiAgentEnabled, pickTuiAgent } from '../../shared/tui-agent-selection'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import {
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

  const isRemote = repoIsRemote(repo)
  const platform = environment.getLaunchPlatform()
  const shell = resolveLocalWindowsAgentStartupShell({
    platform,
    isRemote,
    terminalWindowsShell: settings.terminalWindowsShell
  })
  const launchArgs = {
    agent,
    cmdOverrides: settings.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv),
    platform,
    shell,
    isRemote
  }
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
  const platform = environment.getLaunchPlatform()
  const isRemote = repoIsRemote(repo)
  const sessionOptions = environment.toSessionOptions(environment.launchPreferences)
  const startupPlan = buildAgentStartupPlan({
    agent,
    prompt: environment.prompt ?? '',
    cmdOverrides: settings.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv),
    sessionOptions,
    sessionOptionsOverrideAgentArgs: Boolean(sessionOptions),
    platform,
    shell: resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: settings.terminalWindowsShell
    }),
    isRemote,
    allowEmptyPromptLaunch: true
  })
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
      ...(startupPlan.env ? { env: startupPlan.env } : {})
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
