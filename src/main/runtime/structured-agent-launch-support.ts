import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import {
  resolveStructuredAgentSessionCreateSupport,
  warnStructuredAgentSessionCreateUnsupported,
  type StructuredAgentSessionCreateSupport
} from '../native-chat/structured-agent-session-create-support'
import { structuredAgentRuntimeRegistration } from './structured-agent-runtime-registrations'
import { resolveHostAgentBaseEnvironment } from './structured-agent-shell-environment'

type LaunchEnvironmentSettings = Pick<
  GlobalSettings,
  'agentDefaultEnv' | 'nativeChatInheritShellEnvironment' | 'nativeChatShellEnvironmentVariables'
> &
  Partial<Pick<GlobalSettings, 'agentCmdOverrides'>>

/** What the check reads from the runtime asking it. */
type LaunchSupportRuntime = {
  requireStore(): { getSettings(): LaunchEnvironmentSettings }
  resolveRuntimeFileTarget(selector: string): Promise<{ worktree: { path: string } }>
}

/** The agent's own check of what is installed on this host, with the environment and Command
 *  setting its launch starts from, in the workspace it would launch in; true for an agent whose
 *  location alone decides. */
export async function structuredAgentSupportsLaunch(
  agent: string,
  worktreeSelector: string,
  runtime: LaunchSupportRuntime
): Promise<boolean> {
  const supportsLaunch = structuredAgentRuntimeRegistration(agent)?.supportsLaunch
  if (!supportsLaunch) {
    return true
  }
  const settings = runtime.requireStore().getSettings()
  const env = {
    ...(await resolveHostAgentBaseEnvironment(settings)),
    ...(isTuiAgent(agent) ? resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv) : {})
  }
  const cwd = (await runtime.resolveRuntimeFileTarget(worktreeSelector)).worktree.path
  return supportsLaunch({ cwd, env, commandSettings: settings })
}

/** `agentSession.createSupport` on this host: every refusal it can know before spawning. The
 *  agent's location rule and installed-agent check from its registration, without installing the
 *  host. A refusal logs which check said no. */
export async function resolveHostStructuredAgentCreateSupport(input: {
  agent: StructuredAgentId
  worktreeSelector: string
  location: AgentSessionExecutionLocation
  runtime: LaunchSupportRuntime
}): Promise<StructuredAgentSessionCreateSupport> {
  const { agent, location } = input
  const supportsLocation =
    structuredAgentRuntimeRegistration(agent)?.supportsLocation(location) ?? false
  const supportsLaunch =
    supportsLocation &&
    (await structuredAgentSupportsLaunch(agent, input.worktreeSelector, input.runtime))
  const support = resolveStructuredAgentSessionCreateSupport({
    location,
    adapterSupportsCreate: supportsLaunch
  })
  warnStructuredAgentSessionCreateUnsupported(
    agent,
    support,
    supportsLocation ? 'installed-agent' : 'location'
  )
  return support
}
