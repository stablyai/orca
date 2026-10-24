import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import {
  checkAgentCliVersion,
  launchableRelease,
  type AgentCliVersionCheck
} from '../agent-cli-version-probe'
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
type LaunchSettingsRuntime = { requireStore(): { getSettings(): LaunchEnvironmentSettings } }
type LaunchSupportRuntime = LaunchSettingsRuntime & {
  resolveRuntimeFileTarget(selector: string): Promise<{ worktree: { path: string } }>
}

/** The agent's own check of the release installed on this host, with the environment and Command
 *  setting its launch starts from, run in `cwd`; null for an agent whose location alone decides.
 *  Throws the launch's pre-spawn refusal for an unrunnable Command setting. */
export async function observeStructuredAgentLaunch(
  agent: string,
  cwd: () => Promise<string>,
  runtime: LaunchSettingsRuntime,
  refreshShellOnMiss: boolean
): Promise<AgentCliVersionCheck | null> {
  const check = structuredAgentRuntimeMetadata(agent)?.launchCheck
  if (!check) {
    return null
  }
  const settings = runtime.requireStore().getSettings()
  let directory: Promise<string> | undefined
  const once = () => (directory ??= cwd())
  // Resolved as a launch resolves, sharing its refresh, so an agent installed since the shell was
  // last read counts and a found one never waits.
  const launch = await resolveAgainAfterRefreshOnMissingProgram(
    async () =>
      check.resolveLaunch(
        await resolveHostStructuredAgentLaunchEnvironment(agent, settings),
        settings
      ),
    refreshShellOnMiss ? refreshHostAgentBaseEnvironmentAfterMiss : undefined,
    { env: ({ env }) => env, cwd: once }
  )
  return checkAgentCliVersion(
    { program: launch.command, cwd: await once(), env: launch.env },
    check.minimumVersions
  )
}

/** Admission's answer in the workspace `cwd` names: only a too-old or unstartable binary keeps the
 *  terminal. */
export async function structuredAgentSupportsLaunch(
  agent: string,
  cwd: () => Promise<string>,
  runtime: LaunchSettingsRuntime
): Promise<boolean> {
  try {
    const release = await observeStructuredAgentLaunch(agent, cwd, runtime, true)
    return release === null || launchableRelease(release)
  } catch (error) {
    // An unrunnable Command setting is the launch's refusal to state, not a terminal.
    if (isAgentSessionPreSpawnError(error)) {
      return true
    }
    throw error
  }
}

/** The environment a new local chat launch starts from, before its account binding. */
export async function resolveHostStructuredAgentLaunchEnvironment(
  agent: string,
  settings: LaunchEnvironmentSettings
): Promise<Record<string, string>> {
  return {
    ...(await resolveHostAgentBaseEnvironment(settings)),
    ...(isTuiAgent(agent) ? resolveTuiAgentLaunchEnv(agent, settings) : {})
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
  const { agent, location, runtime } = input
  const supportsLocation =
    structuredAgentRuntimeMetadata(agent)?.supportsLocation(location) ?? false
  const supportsLaunch =
    supportsLocation &&
    (await structuredAgentSupportsLaunch(
      agent,
      async () => (await runtime.resolveRuntimeFileTarget(input.worktreeSelector)).worktree.path,
      runtime
    ))
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
