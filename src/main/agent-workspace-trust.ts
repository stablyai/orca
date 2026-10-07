import { homedir } from 'node:os'
import {
  AGENT_TRUST_WRITE_DEADLINE_MS,
  SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
} from './agent-trust-write-deadline'
import type { AgentTrustPreset } from './agent-trust-presets'
import { resolveLocalClaudeTrustConfig } from './claude/claude-folder-trust-file'
import type { ClaudeRuntimeAuthPreparation } from './claude-accounts/runtime-auth/runtime-auth-types'
import type { AgentWorkspaceTrustSpawnRequest } from '../shared/agent-workspace-trust-spawn-request'
import { parseWslUncPath } from '../shared/wsl-paths'
import {
  applyWorkspaceTrustOnThisHost,
  launchedAgentHome,
  launchedCodexConfigFile
} from './execution-host-workspace-trust'
import { getLocalCodexTrustConfigFiles } from './codex/codex-home-paths'
import { getCachedWslHome } from './wsl-home-cache'

/** What a trust writer needs to reach the file the launched agent will read. */
export type AgentTrustLaunchContext = {
  /** The final spawn env, before the host's own process env. */
  env: Record<string, string | undefined> | undefined
  /** Managed-account auth prep for a Claude launch; names a WSL guest's config dir. */
  claudeAuth: ClaudeRuntimeAuthPreparation | null
  wslDistro: string | null
  /** SSH connection that runs the agent; null means this machine. */
  connectionId: string | null
  /** The CODEX_HOME Orca gives this launch's Codex; null means Codex's default home. */
  codexHome: string | null
}

/** Spawn fields the dispatcher asks the caller to forward to the process owner. */
export type AgentTrustSpawnFields = {
  agentWorkspaceTrust?: AgentWorkspaceTrustSpawnRequest
}

function isWslLaunch(workspacePath: string, context: AgentTrustLaunchContext): boolean {
  return (
    Boolean(context.wslDistro) ||
    context.claudeAuth?.runtime === 'wsl' ||
    parseWslUncPath(workspacePath) !== null
  )
}

/** Homes an agent on this machine may read trust under; SSH hosts check their own. */
function localHomePaths(workspacePath: string, context: AgentTrustLaunchContext) {
  const wslWorkspace = parseWslUncPath(workspacePath)
  // Why: a WSL guest agent reads trust under the guest's home; an uncached one means write nothing.
  return wslWorkspace
    ? [getCachedWslHome(wslWorkspace.distro)]
    : [homedir(), context.env?.HOME, context.env?.USERPROFILE]
}

/**
 * Pre-trusts `workspacePath` for the agent Orca is about to start, on the host that runs
 * it. Never throws and never waits past the preset's deadline: a miss means the agent asks.
 */
export async function applyAgentWorkspaceTrust(
  preset: AgentTrustPreset,
  workspacePath: string,
  context: AgentTrustLaunchContext
): Promise<AgentTrustSpawnFields> {
  if (context.connectionId) {
    // Why: the SSH host's relay writes on its own disk, under its own homes and the agent's final env.
    return { agentWorkspaceTrust: { workspacePath } }
  }
  // Why: the other writers target this host's home, which a WSL guest agent never reads.
  if (preset !== 'claude' && isWslLaunch(workspacePath, context)) {
    return {}
  }
  await applyWorkspaceTrustOnThisHost(preset, workspacePath, () => {
    const agentHome = launchedAgentHome(context.env)
    return {
      homes: localHomePaths(workspacePath, context),
      agentHome,
      claudeConfig: () =>
        resolveLocalClaudeTrustConfig({
          workspacePath,
          env: { ...process.env, ...context.env },
          claudeAuth: context.claudeAuth,
          wslDistro: context.wslDistro
        }),
      // Why agentHome: with no CODEX_HOME, Codex reads `.codex` under the home it resolves `~` to.
      codexConfigFiles: () =>
        getLocalCodexTrustConfigFiles(launchedCodexConfigFile(context.codexHome, agentHome)),
      // Why: Codex queues behind a config lane it shares with Orca's hook installs.
      deadlineMs:
        preset === 'codex' ? AGENT_TRUST_WRITE_DEADLINE_MS : SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
    }
  })
  return {}
}
