import { isAgentLaunchProfileId } from '../../shared/agent-launch-profile/agent-launch-profile'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { RuntimeClientError } from '../runtime-client'

function getPresentStringFlag(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', `Missing value for --${name}`)
}

export type WorktreeStartupAgentFlags = {
  startupAgent?: string
  startupLaunchProfileId?: string
}

/** `--agent` plus its dependents; `--prompt` and `--launch-profile` are meaningless without it. */
export function getWorktreeStartupAgentFlags(
  flags: Map<string, string | boolean>
): WorktreeStartupAgentFlags {
  const agent = getPresentStringFlag(flags, 'agent')
  if (agent === undefined) {
    if (flags.has('prompt')) {
      throw new RuntimeClientError('invalid_argument', '--prompt requires --agent')
    }
    if (flags.has('launch-profile')) {
      throw new RuntimeClientError('invalid_argument', '--launch-profile requires --agent')
    }
    return {}
  }
  if (!isTuiAgent(agent)) {
    throw new RuntimeClientError('invalid_argument', `Unknown TUI agent "${agent}"`)
  }
  const launchProfileId = getPresentStringFlag(flags, 'launch-profile')
  if (launchProfileId === undefined) {
    return { startupAgent: agent }
  }
  // Why: only the shape is checked here; the host owns the profile catalog and reports
  // agent_session_launch_profile_unknown / _agent_mismatch for ids it does not serve.
  // Why: the guard narrows the rejected branch to never, so the message is built before it.
  const rejected = `Invalid --launch-profile "${launchProfileId}" (expected a lowercase slug such as codex-secondary-home)`
  if (!isAgentLaunchProfileId(launchProfileId)) {
    throw new RuntimeClientError('invalid_argument', rejected)
  }
  return { startupAgent: agent, startupLaunchProfileId: launchProfileId }
}
