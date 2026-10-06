// Common profile preparation stays separate from ordinary selected-account launch routing.
import {
  prepareTerminalProfileLaunch,
  hasTerminalProfileBinding
} from '../host-env/agent-profile-launch'
import { bindAgentProfileTerminalEnvironment } from '../../../agent-profiles/terminal-command'
import { bindClaudeProfileTerminalEnvironment } from '../../../claude-accounts/claude-profile-cli'
import { planCodexNoDaemonLaunch } from '../../../pty/codex-no-daemon-launch-command'
import type { RuntimePtySpawnState } from './spawn-state'
export async function prepareRuntimeAgentProfile(ctx: RuntimePtySpawnState): Promise<void> {
  const args = ctx.args
  ctx.profileAttachOnly =
    hasTerminalProfileBinding(args) &&
    !args.connectionId &&
    args.sessionId !== undefined &&
    args.isNewSession !== true
  ctx.agentProfile = await prepareTerminalProfileLaunch(args, {
    service: ctx.deps.agentProfiles,
    reattach: Boolean(ctx.preAdoptedStablePane) || ctx.profileAttachOnly,
    resume: Boolean(args.resumeProviderSession),
    isWsl: ctx.codexSelectionTarget.runtime === 'wsl',
    cwd: ctx.cwd
  })
  if (ctx.profileAttachOnly) {
    ctx.isClaudeLaunch = false
  }
  if (ctx.agentProfile) {
    ctx.isClaudeLaunch = ctx.agentProfile.snapshot.agent === 'claude'
  }
}
export async function prepareRuntimeProfileCommand(ctx: RuntimePtySpawnState): Promise<void> {
  const args = ctx.args
  if (ctx.agentProfile) {
    await ctx.deps.agentProfiles!.validateLaunch(ctx.agentProfile, {
      cwd: ctx.cwd ?? process.cwd(),
      env: { ...process.env, ...ctx.env }
    })
  }
  const noDaemonLaunch = planCodexNoDaemonLaunch({
    trustedExecutable:
      ctx.agentProfile?.snapshot.agent === 'codex'
        ? ctx.agentProfile.snapshot.executable
        : undefined,
    command: ctx.launchCommand,
    executesOnThisHost: !args.connectionId && ctx.codexSelectionTarget.runtime !== 'wsl',
    shellOverride: ctx.daemonShellOverride,
    env: ctx.env,
    envToDelete: ctx.spawnOptions.envToDelete,
    cwd: ctx.cwd
  })
  const launchCommand = noDaemonLaunch ? await noDaemonLaunch : ctx.launchCommand
  if (launchCommand !== undefined) {
    ctx.spawnOptions.command = ctx.agentProfile
      ? bindAgentProfileTerminalEnvironment(ctx.agentProfile, launchCommand)
      : bindClaudeProfileTerminalEnvironment(launchCommand, ctx.claudeAuth)
  }
}
