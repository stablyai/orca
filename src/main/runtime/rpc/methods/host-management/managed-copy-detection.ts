// Whether Orca's copies of agent CLIs may run here, and which are installed, for agent detection.

import { delimiter, dirname, isAbsolute } from 'node:path'
import { acpLaunchSpecFor } from '../../../../acp/launch/acp-launch-registry'
import type { ManagedCopySettings } from '../../../../acp/launch/acp-launch-contract'
import {
  installedManagedAgentCommand,
  installedManagedAgentLauncher,
  isManagedAgentCli,
  isManagedAgentCopyPath,
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
import { resolveCliCommandAsync } from '../../../../../shared/shell/command-resolution/node-cli-command-async-resolution'
import {
  getTuiAgentLaunchCommand,
  TUI_AGENT_CONFIG
} from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { ManagedAgentCommands } from '../../../../../shared/agent-launch/startup/managed-agent-launch-program'
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

/** Paths are known once launch reclaim has read the releases; a startup detection waits for it. */
async function managedAgentLauncherOnceRead(agent: string): Promise<string | null> {
  if (!isManagedAgentCli(agent)) {
    return null
  }
  if (!releasesRead) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      releasesReadOnce.promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RELEASE_READ_WAIT_MS)
      })
    ])
    clearTimeout(timer)
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

/** Orca's installed copy of `agent` when it may run and stands in for `program`; else null. */
function managedCopyFor(agent: TuiAgent, program: string, settings: LaunchSettings): string | null {
  if (!isManagedAgentCli(agent) || !managedAgentStandsInFor(agent, program)) {
    return null
  }
  return standInSpec(agent)?.managedCopyAllowed?.(settings) === false
    ? null
    : installedManagedAgentLauncher(agent)
}

// Launches that start together share one lookup per program.
const ownProgramLookups = new Map<string, Promise<string>>()

function lookUpOwnProgram(program: string): Promise<string> {
  const pending = ownProgramLookups.get(program)
  if (pending) {
    return pending
  }
  const lookup = resolveCliCommandAsync(program)
    .catch(() => program)
    .finally(() => ownProgramLookups.delete(program))
  ownProgramLookups.set(program, lookup)
  return lookup
}

function onTerminalPath(file: string): boolean {
  const folder = dirname(file)
  // Node reads PATH case-insensitively on Windows.
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some(
      (entry) => entry && isPathInsideOrEqual(entry, folder) && isPathInsideOrEqual(folder, entry)
    )
}

/** Full paths the launches of `agents` on this host run in place of the stock program (also when a
 *  Command setting names it): Orca's copy where the user has no CLI of their own, or the user's CLI
 *  found only outside PATH (in its installer's folder), which a terminal can't run by name. */
export async function readHostManagedAgentCommands(
  settings: LaunchSettings,
  agents: readonly TuiAgent[]
): Promise<ManagedAgentCommands> {
  const commands: ManagedAgentCommands = {}
  await Promise.all(
    agents.map(async (agent) => {
      try {
        const [program] = getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], process.platform).split(
          ' '
        )
        const own = await lookUpOwnProgram(program)
        const managed = managedCopyFor(agent, program, settings)
        if (own === program || (isManagedAgentCli(agent) && isManagedAgentCopyPath(agent, own))) {
          if (managed) {
            commands[agent] = managed
          }
        } else if (isAbsolute(own) && !onTerminalPath(own)) {
          commands[agent] = own
        }
      } catch (error) {
        console.warn('[managed-runtime] launch left to its stock program:', error)
      }
    })
  )
  return commands
}
