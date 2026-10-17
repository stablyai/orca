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
import { isAgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  resolveAgainAfterRefreshOnMissingProgram,
  type StructuredAgentCommandSettings
} from '../native-chat/structured-agent-command-resolution'
import { structuredAgentRuntimeMetadata } from './structured-agent-runtime-metadata'
import {
  refreshHostAgentBaseEnvironmentAfterMiss,
  resolveHostAgentBaseEnvironment
} from './structured-agent-shell-environment'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

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
  const check = structuredAgentRuntimeMetadata(agent)?.launchCheck
  if (!check) {
    return true
  }
  const settings = runtime.requireStore().getSettings()
  let worktreePath: Promise<string> | undefined
  const cwd = () =>
    (worktreePath ??= runtime
      .resolveRuntimeFileTarget(worktreeSelector)
      .then((target) => target.worktree.path))
  let launch: { command: string; env: Record<string, string> }
  try {
    // Resolved as a launch resolves, sharing its refresh, so an agent installed since the shell
    // was last read counts and a found one never waits.
    launch = await resolveAgainAfterRefreshOnMissingProgram(
      async () =>
        check.resolveLaunch(
          await resolveHostStructuredAgentLaunchEnvironment(agent, settings),
          settings
        ),
      refreshHostAgentBaseEnvironmentAfterMiss,
      { env: ({ env }) => env, cwd }
    )
  } catch (error) {
    // An unrunnable Command setting is the launch's refusal to state, not a terminal.
    if (isAgentSessionPreSpawnError(error)) {
      return true
    }
    throw error
  }
  return check.supportsVersion({ ...launch, cwd: await cwd() })
}

/** The environment a new local chat launch starts from, before its account binding. */
export async function resolveHostStructuredAgentLaunchEnvironment(
  agent: string,
  settings: LaunchEnvironmentSettings
): Promise<Record<string, string>> {
  return {
    ...(await resolveHostAgentBaseEnvironment(settings)),
    ...(isTuiAgent(agent) ? resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv) : {})
  }
}

/** What a chat start of `agent` on this host launches from, for a child that serves no chat. */
export async function structuredAgentHostLaunchSources(
  agent: StructuredAgentId,
  runtime: Pick<LaunchSupportRuntime, 'requireStore'> & {
    resolveStructuredAgentAccountHome(agent: StructuredAgentId): Promise<AgentSessionAccountHome>
  }
): Promise<{
  accountHome: AgentSessionAccountHome
  env: Record<string, string>
  commandSettings: StructuredAgentCommandSettings
  dataDirectory: string
}> {
  const settings = runtime.requireStore().getSettings()
  return {
    accountHome: await runtime.resolveStructuredAgentAccountHome(agent),
    env: await resolveHostStructuredAgentLaunchEnvironment(agent, settings),
    commandSettings: settings,
    // The chat host's own state root (ensureStructuredAgentSessionHost).
    dataDirectory: getProfileUserDataPath()
  }
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
    structuredAgentRuntimeMetadata(agent)?.supportsLocation(location) ?? false
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
