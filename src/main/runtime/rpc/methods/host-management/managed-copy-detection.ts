// Whether Orca's copies of agent CLIs may run here, and which are installed, for agent detection.

import { delimiter, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { acpLaunchSpecFor } from '../../../../acp/launch/acp-launch-registry'
import type { ManagedCopySettings } from '../../../../acp/launch/acp-launch-contract'
import {
  installedManagedAgentCommand,
  installedManagedAgentLauncher,
  isManagedAgentCli,
  launchReleasesPending,
  MANAGED_AGENT_CLI_IDS,
  managedAgentCli,
  managedAgentStandsInFor,
  noteLaunchReleasesRecorded,
  type ManagedAgentCliId
} from '../../../../managed-agent-cli/managed-agent-cli-registry'
import { runtimeReleaseMayBePublished } from '../../../../node-runtime/managed-runtime-release'
import { getProfileUserDataPath } from '../../../../orca-profiles/profile-storage-paths'
import {
  isOrcaAgentRuntimePath,
  lookUpPathProgram,
  terminalPathReachesUserProgram,
  withoutOrcaAgentRuntimeDirectories
} from '../../../../managed-agent-cli/managed-agent-cli-path'
import { provideInstalledManagedAgents } from '../../../../preflight/managed-agent-detection'
import {
  notifyAgentsRefreshedOnHost,
  onAgentsRefreshedOnHost
} from '../../../../preflight/agents-refreshed-on-host'
import { isQuotedWindowsPathEntry } from '../../../../../shared/shell/command-resolution/node-cli-command-resolution'
import {
  inferLaunchShell,
  readLaunchPosition
} from '../../../../../shared/agent-launch/startup/launch-position'
import {
  resolveCliCommandAsync,
  resolveExecutableCommandAsync
} from '../../../../../shared/shell/command-resolution/node-cli-command-async-resolution'
import {
  matchesStockLaunchProgram,
  stockLaunchProgram,
  type ManagedAgentCommands
} from '../../../../../shared/agent-launch/startup/managed-agent-launch-program'
import type { AgentStartupShell } from '../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveLoginShellEnvironment } from '../../../../startup/shell-environment/login-shell-environment'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

/** ACP agents name their own program and search their installers' folders after PATH, as launches
 *  do; an agent with a host program is looked for as that program. */
export function standInSpec(agent: ManagedAgentCliId) {
  const outer = acpLaunchSpecFor(agent)
  return [outer, outer?.hostBackend?.spec].find(
    (each) => each && managedAgentStandsInFor(agent, each.command)
  )
}

/** The settings whether Orca's copies may run comes from. */
export type ManagedCopySettingsSource = { requireStore(): { getSettings(): ManagedCopySettings } }

export function managedCopyMayRun(
  agent: ManagedAgentCliId,
  runtime: ManagedCopySettingsSource
): boolean {
  return standInSpec(agent)?.managedCopyAllowed?.(runtime.requireStore().getSettings()) !== false
}

// What the disk check counted before launch reclaim read the releases, so that read can say when
// it disagrees.
let countedOnDisk: readonly ManagedAgentCliId[] = []
let detectionSettings: ManagedCopySettingsSource | null = null

function rememberedManagedAgents(runtime: ManagedCopySettingsSource): ManagedAgentCliId[] {
  return MANAGED_AGENT_CLI_IDS.filter(
    (agent) => managedCopyMayRun(agent, runtime) && installedManagedAgentCommand(agent) !== null
  )
}

// Bounds how long a startup detection waits for the read before reporting no path.
const RELEASE_READ_WAIT_MS = 10_000
let releaseReadWait: Promise<void> | undefined

/** Paths are known once launch reclaim has read the releases; a startup detection waits for it. */
async function managedAgentLauncherOnceRead(agent: string): Promise<string | null> {
  if (!isManagedAgentCli(agent)) {
    return null
  }
  const pending = launchReleasesPending()
  if (pending !== null) {
    if (!releaseReadWait) {
      let timer: ReturnType<typeof setTimeout> | undefined
      releaseReadWait = Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RELEASE_READ_WAIT_MS)
        })
      ]).finally(() => {
        clearTimeout(timer)
        releaseReadWait = undefined
      })
    }
    await releaseReadWait
  }
  return installedManagedAgentLauncher(agent)
}

/** An installed chat copy can be used by its native-chat provider. Until launch reclaim
 *  has read Orca's releases, detection looks for them itself, so no reader waits for that read. */
export function provideManagedAgentDetection(runtime: ManagedCopySettingsSource): void {
  detectionSettings = runtime
  provideInstalledManagedAgents(async () => {
    try {
      // Once launch reclaim has read every release, installs and removals keep them current.
      if (launchReleasesPending() === null) {
        return rememberedManagedAgents(runtime)
      }
      const dataDirectory = getProfileUserDataPath()
      const present = await Promise.all(
        MANAGED_AGENT_CLI_IDS.map(
          async (agent) =>
            managedCopyMayRun(agent, runtime) &&
            (await runtimeReleaseMayBePublished(managedAgentCli(agent).runtime.root(dataDirectory)))
        )
      )
      countedOnDisk = MANAGED_AGENT_CLI_IDS.filter((_, index) => present[index])
      return countedOnDisk
    } catch (error) {
      // Without settings Orca can't tell which copies may run; detection goes on without them.
      console.warn('[managed-runtime] Orca-installed agents left out of detection:', error)
      return []
    }
  })
}

/** Launch reclaim has read Orca's releases: detection answers from them from now on, and a copy the
 *  disk check counted that the read found unusable (damaged, another platform's) is announced. */
export function noteManagedReleasesRead(): void {
  noteLaunchReleasesRecorded()
  const counted = countedOnDisk
  countedOnDisk = []
  if (counted.length === 0 || !detectionSettings) {
    return
  }
  try {
    const remembered = rememberedManagedAgents(detectionSettings)
    if (counted.some((agent) => !remembered.includes(agent))) {
      notifyAgentsRefreshedOnHost()
    }
  } catch (error) {
    // Startup goes on; at worst a list keeps a copy until it is next read.
    console.warn('[managed-runtime] could not compare Orca-installed agents:', error)
  }
}

type LaunchSettings = ManagedCopySettings & {
  agentCmdOverrides?: Partial<Record<TuiAgent, string>> | null
}

async function managedCopyFor(
  agent: TuiAgent,
  program: string,
  settings: LaunchSettings
): Promise<string | null> {
  if (!isManagedAgentCli(agent) || !managedAgentStandsInFor(agent, program)) {
    return null
  }
  if (standInSpec(agent)?.managedCopyAllowed?.(settings) === false) {
    return null
  }
  const launcher =
    installedManagedAgentLauncher(agent) ??
    (detectionSettings ? await managedAgentLauncherOnceRead(agent) : null)
  return launcher ? validateLauncher(launcher) : null
}

const launcherLookups = new Map<string, Promise<string | null>>()

function validateLauncher(path: string): Promise<string | null> {
  const pending = launcherLookups.get(path)
  if (pending) {
    return pending
  }
  const lookup = resolveExecutableCommandAsync(path).finally(() => launcherLookups.delete(path))
  launcherLookups.set(path, lookup)
  return lookup
}

function acceptsQuotedPathEntries(shell?: AgentStartupShell): boolean {
  return shell === 'cmd' || shell === 'posix'
}

// Saved launches reuse installer discovery until the host refreshes its agent inventory.
// The terminal's actual PATH is still searched on every restore.
const restoredInstallLookups = new Map<string, Promise<string>>()
let restoredInstallHome: string | undefined
onAgentsRefreshedOnHost(() => restoredInstallLookups.clear())

async function lookUpInstallProgram(program: string, restoring: boolean): Promise<string> {
  if (!restoring) {
    return resolveCliCommandAsync(program, { skipPathSearch: true })
  }
  const homePath = homedir()
  if (restoredInstallHome !== homePath) {
    restoredInstallHome = homePath
    restoredInstallLookups.clear()
  }
  const cached = restoredInstallLookups.get(program)
  if (cached) {
    const path = await cached
    if (path === program || (await validateLauncher(path))) {
      return path
    }
    if (restoredInstallLookups.get(program) !== cached) {
      return lookUpInstallProgram(program, restoring)
    }
  }
  const lookup = resolveCliCommandAsync(program, { homePath, skipPathSearch: true }).catch(
    (error: unknown) => {
      if (restoredInstallLookups.get(program) === lookup) {
        restoredInstallLookups.delete(program)
      }
      throw error
    }
  )
  restoredInstallLookups.set(program, lookup)
  return lookup
}

async function lookUpTerminalProgram(
  program: string,
  pathEnv: string,
  preferUnquotedPath: boolean
): Promise<string | null> {
  if (preferUnquotedPath) {
    const entries = pathEnv.split(delimiter)
    const unquotedEntries = entries.filter((entry) => !isQuotedWindowsPathEntry(entry))
    if (unquotedEntries.length !== entries.length) {
      const onUnquotedPath = await lookUpPathProgram(program, unquotedEntries.join(delimiter))
      if (onUnquotedPath !== null) {
        return onUnquotedPath
      }
      pathEnv = entries.filter(isQuotedWindowsPathEntry).join(delimiter)
    }
  }
  return lookUpPathProgram(program, pathEnv)
}

type HostPathOptions = {
  pathEnv?: string
  shell?: AgentStartupShell
  restoring?: boolean
}

async function resolveHostPath(pathEnv: string | undefined): Promise<string> {
  if (pathEnv !== undefined) {
    return pathEnv
  }
  const env = await resolveLoginShellEnvironment()
  return env.PATH ?? env.Path ?? ''
}

/** Null for a missing user CLI, its name or absolute path when present. */
async function findUserProgram(
  program: string,
  pathEnv: string,
  options: HostPathOptions
): Promise<string | null> {
  const acceptsQuotes = acceptsQuotedPathEntries(options.shell)
  const onPath = await lookUpTerminalProgram(
    program,
    withoutOrcaAgentRuntimeDirectories(pathEnv),
    process.platform === 'win32' && !acceptsQuotes
  )
  const own = onPath ?? (await lookUpInstallProgram(program, options.restoring === true))
  if (own === program || isOrcaAgentRuntimePath(own)) {
    return null
  }
  return isAbsolute(own) &&
    !(await terminalPathReachesUserProgram(program, own, pathEnv, acceptsQuotes))
    ? own
    : program
}

/** A native-chat login uses the host's own CLI first, then the installed chat runtime. */
export async function resolveNativeChatSignInProgram(
  agent: TuiAgent,
  program: string,
  settings: LaunchSettings,
  options: HostPathOptions
): Promise<string | null> {
  const pathEnv = await resolveHostPath(options.pathEnv)
  const own = await findUserProgram(program, pathEnv, options).catch(() => null)
  if (own === null) {
    return managedCopyFor(agent, program, settings)
  }
  return own === program ? null : own
}

/** Full paths to user installs that the target shell cannot reach by name. */
export async function readHostManagedAgentCommands(
  settings: LaunchSettings,
  agents: readonly TuiAgent[],
  options: HostPathOptions = {}
): Promise<ManagedAgentCommands> {
  const selections = agents.flatMap((agent) => {
    const program = stockLaunchProgram(agent, process.platform)
    const override = settings.agentCmdOverrides?.[agent]?.trim()
    const executable = override
      ? readLaunchPosition(override, options.shell ?? inferLaunchShell(override))?.executable
      : program
    return matchesStockLaunchProgram(executable, program, process.platform)
      ? [{ agent, program }]
      : []
  })
  const commands: ManagedAgentCommands = {}
  if (selections.length === 0) {
    return commands
  }
  const pathEnv = await resolveHostPath(options.pathEnv)
  await Promise.all(
    selections.map(async ({ agent, program }) => {
      try {
        const own = await findUserProgram(program, pathEnv, options)
        if (own && own !== program) {
          commands[agent] = own
        }
      } catch (error) {
        console.warn('[managed-runtime] launch left to its stock program:', error)
      }
    })
  )
  return commands
}
