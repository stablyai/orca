import {
  reserveAgentProfilePtyOwnership,
  type PreparedTerminalAgentProfile
} from './agent-profile-ownership'
import { assertClaudeProfileCli } from '../../../claude-accounts/claude-profile-cli'
import { CODEX_PROFILE_ROUTING_ENV } from '../../../codex-accounts/profile-launch-authority'
import { AgentProfilePreparationError } from '../../../agent-profiles/preparation-error'
// The execution host captures fresh bindings and resumes their immutable snapshot.
import { copyAgentProfileSnapshot } from '../../../../shared/agent-launch-profile'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentProfileConnectionService } from '../../../agent-profiles/connection-service'
import { pinAgentProfileTerminalCommand } from '../../../agent-profiles/terminal-command'

export type TerminalProfileService = Pick<
  AgentProfileConnectionService,
  'prepare' | 'prepareById' | 'validateLaunch'
>
export type TerminalProfileLaunch = {
  agentProfileId?: string
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  command?: string
  env?: Record<string, string>
  envToDelete?: string[]
  connectionId?: string | null
}
export function hasTerminalProfileBinding(args: TerminalProfileLaunch): boolean {
  return args.agentProfileId !== undefined || args.launchConfig?.agentProfile !== undefined
}
export async function prepareTerminalProfileLaunch(
  args: TerminalProfileLaunch,
  context: {
    service?: TerminalProfileService
    reattach: boolean
    resume: boolean
    isWsl: boolean
    cwd?: string
  }
): Promise<PreparedTerminalAgentProfile | undefined> {
  if (context.reattach || !hasTerminalProfileBinding(args)) {
    return undefined
  }
  if (args.connectionId || context.isWsl || !['darwin', 'linux'].includes(process.platform)) {
    throw new Error(
      'Agent profiles require a local macOS/Linux terminal. Choose a plain agent for this host.'
    )
  }
  if (!context.service) {
    throw new Error('Agent profile launch service is unavailable on this host.')
  }
  const config = args.launchConfig
  const snapshot =
    config?.agentProfile === undefined ? undefined : copyAgentProfileSnapshot(config.agentProfile)
  if (
    config?.claudeAccountId !== undefined ||
    (args.agentProfileId !== undefined &&
      (!/^[A-Za-z0-9_-]{1,128}$/.test(args.agentProfileId) || snapshot !== undefined)) ||
    (context.resume && !snapshot)
  ) {
    throw new Error(
      'Conflicting or missing agent profile binding. Select one profile for a fresh launch; resume its saved binding.'
    )
  }
  if (snapshot && args.launchAgent && snapshot.agent !== args.launchAgent) {
    throw new Error('Saved profile does not match the launch agent.')
  }
  const options = {
    mode: 'terminal' as const,
    resume: context.resume || snapshot !== undefined,
    cwd: context.cwd,
    env: { ...process.env, ...args.env }
  }
  let prepared: PreparedTerminalAgentProfile = snapshot
    ? await context.service.prepare(snapshot, options)
    : await context.service.prepareById(args.agentProfileId!, options)
  try {
    prepared = await reserveAgentProfilePtyOwnership(prepared)
    if (args.launchAgent && prepared.snapshot.agent !== args.launchAgent) {
      throw new Error('Profile does not match the launch agent.')
    }
    if (args.envToDelete?.some((key) => key in prepared.envPatch)) {
      throw new Error('Remove the profile home deletion override before launching.')
    }
    if (
      prepared.snapshot.agent === 'codex' &&
      prepared.snapshot.binding.kind === 'managed' &&
      CODEX_PROFILE_ROUTING_ENV.some((key) => ({ ...process.env, ...args.env })[key] !== undefined)
    ) {
      throw new AgentProfilePreparationError('codex_config')
    }
    if (prepared.snapshot.agent === 'claude' && prepared.snapshot.binding.kind === 'managed') {
      await assertClaudeProfileCli(prepared.snapshot.executable)
    }
    args.command = pinAgentProfileTerminalCommand(prepared, args.command, args.env)
    args.launchAgent = prepared.snapshot.agent
    args.launchConfig = {
      agentArgs: '',
      agentEnv: {},
      ...config,
      agentProfile: copyAgentProfileSnapshot(prepared.snapshot)
    }
    return prepared
  } catch (error) {
    prepared.release()
    throw error
  }
}
