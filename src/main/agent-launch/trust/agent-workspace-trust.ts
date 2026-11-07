import { homedir } from 'node:os'
import {
  AGENT_TRUST_WRITE_DEADLINE_MS,
  SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
} from './agent-trust-write-deadline'
import type { AgentTrustPreset } from './agent-trust-presets'
import { resolveLocalClaudeTrustConfig } from '../../claude/claude-folder-trust-file'
import type { ClaudeRuntimeAuthPreparation } from '../../claude-accounts/runtime-auth/runtime-auth-types'
import type { AgentWorkspaceTrustSpawnRequest } from '../../../shared/agent-workspace-trust-spawn-request'
import { parseWslUncPath, toLinuxPath } from '../../../shared/wsl-paths'
import { applyWorkspaceTrustOnThisHost, launchedAgentHome } from './execution-host-workspace-trust'
import { getLocalCodexTrustConfigFiles } from '../../codex/configuration/homes/codex-home-paths'
import { getCachedWslHome } from '../../wsl/discovery/wsl-home-cache'

export type AgentTrustLaunchContext = {
  /** The final spawn env, before the host's own process env. */
  env: Record<string, string | undefined> | undefined
  /** Managed-account auth prep for a Claude launch; names a WSL guest's config dir. */
  claudeAuth: ClaudeRuntimeAuthPreparation | null
  wslDistro: string | null
  /** SSH connection that runs the agent; null means this machine. */
  connectionId: string | null
  /** CODEX_HOME Orca injects after this step; the env does not carry it yet. */
  codexHome?: string | null
}

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
  // WSL agents need the guest’s home; an uncached home means no trust write.
  return wslWorkspace
    ? [getCachedWslHome(wslWorkspace.distro)]
    : [homedir(), context.env?.HOME, context.env?.USERPROFILE]
}

/** Antigravity in a WSL guest reads `~/.gemini` in the distro, keyed by its Linux cwd. */
async function applyAntigravityWslTrust(
  workspacePath: string,
  context: AgentTrustLaunchContext
): Promise<void> {
  const uncWorkspace = parseWslUncPath(workspacePath)
  const distro = uncWorkspace?.distro ?? context.wslDistro
  // A drive-letter workspace run in the guest starts under /mnt/<drive>.
  const guestPath = uncWorkspace?.linuxPath ?? toLinuxPath(workspacePath)
  // The cached home is a UNC path into the guest; an uncached home means no trust write.
  const guestHome = distro ? getCachedWslHome(distro) : undefined
  if (!guestHome || !guestPath.startsWith('/')) {
    return
  }
  // Keep the host path as the ownership key so worktree removal finds the entry.
  await applyWorkspaceTrustOnThisHost('antigravity', workspacePath, () => ({
    homes: [guestHome],
    agentHome: guestHome,
    guestWorkspacePath: guestPath,
    claudeConfig: () => null,
    codexConfigFiles: () => [],
    deadlineMs: SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
  }))
}

/** Best-effort trust on the execution host; failure or timeout leaves the agent to ask. */
export async function applyAgentWorkspaceTrust(
  preset: AgentTrustPreset,
  workspacePath: string,
  context: AgentTrustLaunchContext
): Promise<AgentTrustSpawnFields> {
  if (context.connectionId) {
    // Forward to the SSH relay so trust is written on the agent’s host.
    return { agentWorkspaceTrust: { workspacePath } }
  }
  // The other writers target local homes, which WSL agents do not read.
  if (preset !== 'claude' && isWslLaunch(workspacePath, context)) {
    if (preset === 'antigravity') {
      await applyAntigravityWslTrust(workspacePath, context)
    }
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
      codexConfigFiles: () => getLocalCodexTrustConfigFiles(agentHome, context.codexHome),
      kimiHome: context.env?.KIMI_CODE_HOME || process.env.KIMI_CODE_HOME,
      // Codex shares its config lock queue with hook installs.
      deadlineMs:
        preset === 'codex' ? AGENT_TRUST_WRITE_DEADLINE_MS : SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
    }
  })
  return {}
}
