import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { isTuiAgent } from '../../shared/tui-agent-config'
import {
  resolveTuiAgentLaunchEnv,
  type AgentLaunchProfileSettings
} from '../../shared/tui-agent-launch-defaults'
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
  resolveHostAgentBaseEnvironment,
  createStructuredAgentEnvironmentResolvers
} from './structured-agent-shell-environment'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { nativeChatShellEnvironmentPolicy } from '../../shared/native-chat/native-chat-shell-environment'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

type LaunchEnvironmentSettings = Pick<
  GlobalSettings,
  'agentDefaultEnv' | 'nativeChatInheritShellEnvironment' | 'nativeChatShellEnvironmentVariables'
> &
  Partial<Pick<GlobalSettings, 'agentCmdOverrides'>> &
  AgentLaunchProfileSettings

/** What the check reads from the runtime asking it. */
type LaunchSettingsRuntime = { requireStore(): { getSettings(): LaunchEnvironmentSettings } }
type LaunchSupportRuntime = LaunchSettingsRuntime & {
  resolveRuntimeFileTarget(selector: string): Promise<{ worktree: { path: string } }>
}

/** Check the installed release with launch env/Command settings in cwd; null means location-only admission. Unrunnable Command settings throw launch refusal. */
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
  },
  signal: AbortSignal
): Promise<{
  accountHome: AgentSessionAccountHome
  env: Record<string, string>
  commandSettings: StructuredAgentCommandSettings
  dataDirectory: string
}> {
  const settings = runtime.requireStore().getSettings()
  const policy = nativeChatShellEnvironmentPolicy(settings)
  const overlay = isTuiAgent(agent) ? { ...resolveTuiAgentLaunchEnv(agent, settings) } : {}
  const environment = createStructuredAgentEnvironmentResolvers({
    prewarm: false,
    processEnvironment: { ...process.env },
    resolveShellEnvironmentPolicy: () => policy,
    resolveAgentLaunchEnv: () => overlay
  })
  const release = environment.bindCatalogSources([agent])
  signal.addEventListener('abort', release, { once: true })
  if (signal.aborted) {
    release()
  }
  return {
    accountHome: await runtime.resolveStructuredAgentAccountHome(agent),
    env: await environment.resolveAgentEnvironment(agent),
    commandSettings: settings,
    // The chat host's own state root (ensureStructuredAgentSessionHost).
    dataDirectory: getProfileUserDataPath()
  }
}

/** Report pre-spawn refusals from registered location/release checks without installing the host; log the refusing check. */
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
