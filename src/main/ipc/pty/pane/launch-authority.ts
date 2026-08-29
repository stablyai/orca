import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import { isPtyIncarnationId } from '../../../../shared/pty-incarnation'

const AGENT_LAUNCH_TOKEN_MAX_LENGTH = 128

export function admitRendererAgentLaunchAuthority(args: {
  launchToken: unknown
  spawnEnv: Record<string, string> | undefined
  launchAgent: unknown
  launchConfig: SleepingAgentLaunchConfig | undefined
  isReattach: boolean
  hasStablePaneOwner: boolean
  incarnationId: unknown
}): { launchToken: string; launchAgent: TuiAgent } | null {
  if (
    args.isReattach ||
    args.hasStablePaneOwner ||
    !args.launchConfig ||
    !isTuiAgent(args.launchAgent) ||
    !isPtyIncarnationId(args.incarnationId) ||
    typeof args.launchToken !== 'string' ||
    args.launchToken.length === 0 ||
    args.launchToken.length > AGENT_LAUNCH_TOKEN_MAX_LENGTH ||
    args.spawnEnv?.ORCA_AGENT_LAUNCH_TOKEN !== args.launchToken
  ) {
    return null
  }
  return { launchToken: args.launchToken, launchAgent: args.launchAgent }
}

/**
 * The pane and launch token a fresh PTY is about to carry, or null when this spawn starts no new
 * process for a pane.
 *
 * Why separate from {@link admitRendererAgentLaunchAuthority}: that gate decides whether the
 * renderer may claim *orchestration* authority, and deliberately refuses a pane that already has
 * an owner. Re-fencing a pane's status is the opposite question — a respawn into an already-owned
 * pane is exactly the case that must be reported, because that is the pane whose previous process
 * the spawn replaced.
 *
 * Why spawnEnv and not the renderer's `launchToken` argument: the env is what this PTY's hook
 * scripts will read and post, so it is the token the status gates will be compared against. A
 * spawn with no token in its env reports `undefined`, which is a statement (this pane's new
 * process has no token), not a missing value.
 */
export function resolveSpawnedPaneLaunchToken(args: {
  validatedPaneKey: string | null
  isReattach: boolean
  spawnEnv: Record<string, string> | undefined
}): { paneKey: string; launchToken: string | undefined } | null {
  // Why a reattach is excluded: rebinding a client to a running PTY starts no process, so it is
  // no evidence about which process owns the pane.
  if (!args.validatedPaneKey || args.isReattach) {
    return null
  }
  const launchToken = args.spawnEnv?.ORCA_AGENT_LAUNCH_TOKEN
  return {
    paneKey: args.validatedPaneKey,
    launchToken:
      typeof launchToken === 'string' && launchToken.trim().length > 0 ? launchToken : undefined
  }
}

export function admitProviderReattachLaunchIdentity(args: {
  isReattach?: boolean
  launchAgent?: unknown
  incarnationId?: unknown
}): { incarnationId: string; launchAgent: TuiAgent } | null {
  if (
    !args.isReattach ||
    !isTuiAgent(args.launchAgent) ||
    !isPtyIncarnationId(args.incarnationId)
  ) {
    return null
  }
  return { incarnationId: args.incarnationId, launchAgent: args.launchAgent }
}

export function shouldRefreshNativeClaudeAgentTeamsEnv(args: {
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
}): boolean {
  const capturedCommand = args.launchConfig?.agentCommand?.trim() || args.command?.trim() || ''
  const capturedArgs = args.launchConfig?.agentArgs?.trim() ?? ''
  const capturedLaunch = `${capturedCommand} ${capturedArgs}`.trim()
  return /(^|\s)--teammate-mode(?:=|\s+)auto(?:\s|$)/.test(capturedLaunch)
}
