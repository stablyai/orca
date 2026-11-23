// Whether Orca's copies of agent CLIs may run here, and which are installed, for agent detection.

import { delimiter, dirname, isAbsolute } from 'node:path'
import { acpLaunchSpecFor } from '../../../../acp/launch/acp-launch-registry'
import type { ManagedCopySettings } from '../../../../acp/launch/acp-launch-contract'
import {
  installedManagedAgentCommand,
  installedManagedAgentLauncher,
  isManagedAgentCli,
  MANAGED_AGENT_CLI_IDS,
  managedAgentCli,
  managedAgentStandsInFor,
  type ManagedAgentCliId
} from '../../../../managed-agent-cli/managed-agent-cli-registry'
import { runtimeReleaseMayBePublished } from '../../../../node-runtime/managed-runtime-release'
import { getProfileUserDataPath } from '../../../../orca-profiles/profile-storage-paths'
import { provideInstalledManagedAgents } from '../../../../preflight/managed-agent-detection'
import { notifyAgentsRefreshedOnHost } from '../../../../preflight/agents-refreshed-on-host'
import { isPathInsideOrEqual } from '../../../../../shared/file-access/cross-platform-path'
import {
  resolveCliCommandAsync,
  resolveExecutableCommandAsync
} from '../../../../../shared/shell/command-resolution/node-cli-command-async-resolution'
import {
  stockLaunchProgram,
  type ManagedAgentCommands
} from '../../../../../shared/agent-launch/startup/managed-agent-launch-program'
import {
  inferLaunchShell,
  readLaunchPosition
} from '../../../../../shared/agent-launch/startup/launch-position'
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

// Set once launch reclaim has read every release, which installs and removals then keep current.
let releasesRead = false
// What the disk check counted before that read, so the read can say when it disagrees.
let countedOnDisk: readonly ManagedAgentCliId[] = []
let detectionSettings: ManagedCopySettingsSource | null = null

function rememberedManagedAgents(runtime: ManagedCopySettingsSource): ManagedAgentCliId[] {
  return MANAGED_AGENT_CLI_IDS.filter(
    (agent) => managedCopyMayRun(agent, runtime) && installedManagedAgentCommand(agent) !== null
  )
}

const releasesReadOnce = Promise.withResolvers<void>()
// Bounds how long a startup detection waits for the read before reporting no path.
const RELEASE_READ_WAIT_MS = 10_000
let releaseReadWait: Promise<void> | undefined

/** Paths are known once launch reclaim has read the releases; a startup detection waits for it. */
async function managedAgentLauncherOnceRead(agent: string): Promise<string | null> {
  if (!isManagedAgentCli(agent)) {
    return null
  }
  if (!releasesRead) {
    if (!releaseReadWait) {
      let timer: ReturnType<typeof setTimeout> | undefined
      releaseReadWait = Promise.race([
        releasesReadOnce.promise,
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

/** An installed copy that may run is an installed agent to menus and Settings. Until launch reclaim
 *  has read Orca's releases, detection looks for them itself, so no reader waits for that read. */
export function provideManagedAgentDetection(runtime: ManagedCopySettingsSource): void {
  detectionSettings = runtime
  provideInstalledManagedAgents(async () => {
    try {
      if (releasesRead) {
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
  }, managedAgentLauncherOnceRead)
}

/** Launch reclaim has read Orca's releases: detection answers from them from now on, and a copy the
 *  disk check counted that the read found unusable (damaged, another platform's) is announced. */
export function noteManagedReleasesRead(): void {
  releasesRead = true
  releasesReadOnce.resolve()
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
  return launcher ? validateManagedLauncher(launcher) : null
}

// Launches that start together share the same PATH/install-directory lookup.
const ownProgramLookups = new Map<string, Promise<string>>()
const managedLauncherLookups = new Map<string, Promise<string | null>>()

function validateManagedLauncher(path: string): Promise<string | null> {
  const pending = managedLauncherLookups.get(path)
  if (pending) {
    return pending
  }
  const lookup = resolveExecutableCommandAsync(path).finally(() =>
    managedLauncherLookups.delete(path)
  )
  managedLauncherLookups.set(path, lookup)
  return lookup
}

function lookUpOwnProgram(program: string, pathEnv: string): Promise<string> {
  const key = `${program}\0${pathEnv}`
  const pending = ownProgramLookups.get(key)
  if (pending) {
    return pending
  }
  const lookup = resolveCliCommandAsync(program, { pathEnv })
    .catch(() => program)
    .finally(() => ownProgramLookups.delete(key))
  ownProgramLookups.set(key, lookup)
  return lookup
}

function onTerminalPath(file: string, pathEnv: string): boolean {
  const folder = dirname(file)
  return pathEnv
    .split(delimiter)
    .some(
      (entry) => entry && isPathInsideOrEqual(entry, folder) && isPathInsideOrEqual(folder, entry)
    )
}

function withoutManagedDirectories(agent: TuiAgent, pathEnv: string): string {
  if (!isManagedAgentCli(agent)) {
    return pathEnv
  }
  const root = managedAgentCli(agent).runtime.root(getProfileUserDataPath())
  return pathEnv
    .split(delimiter)
    .filter((entry) => !isPathInsideOrEqual(root, entry))
    .join(delimiter)
}

/** Launch selection uses the captured shell PATH, installers' directories, then the current registry launcher. */
export async function readHostManagedAgentCommands(
  settings: LaunchSettings,
  agents: readonly TuiAgent[],
  options: { pathEnv?: string; shell?: AgentStartupShell; forDelivery?: boolean } = {}
): Promise<ManagedAgentCommands> {
  const selections = agents.flatMap((agent) => {
    const program = stockLaunchProgram(agent, process.platform)
    const override = settings.agentCmdOverrides?.[agent]?.trim()
    return options.forDelivery ||
      !override ||
      readLaunchPosition(override, options.shell ?? inferLaunchShell(override))?.executable ===
        program
      ? [{ agent, program }]
      : []
  })
  const commands: ManagedAgentCommands = {}
  if (selections.length === 0) {
    return commands
  }
  const env = options.pathEnv === undefined ? await resolveLoginShellEnvironment() : undefined
  const pathEnv = options.pathEnv ?? env?.PATH ?? env?.Path ?? ''
  await Promise.all(
    selections.map(async ({ agent, program }) => {
      try {
        const own = await lookUpOwnProgram(program, withoutManagedDirectories(agent, pathEnv))
        if (own === program) {
          const managed = await managedCopyFor(agent, program, settings)
          if (managed) {
            commands[agent] = managed
          }
        } else if (isAbsolute(own) && !onTerminalPath(own, pathEnv)) {
          commands[agent] = own
        }
      } catch (error) {
        console.warn('[managed-runtime] launch left to its stock program:', error)
      }
    })
  )
  return commands
}
