// Whether Orca's copies of agent CLIs may run here, and which are installed, for agent detection.

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
import { resolveCliCommandAsync } from '../../../../../shared/shell/command-resolution/node-cli-command-async-resolution'
import {
  getTuiAgentLaunchCommand,
  isTuiAgent,
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

type ManagedCopyCandidate = { agent: ManagedAgentCliId & TuiAgent; path: string; program: string }

type LaunchSettings = ManagedCopySettings & {
  agentCmdOverrides?: Partial<Record<TuiAgent, string>> | null
}

function managedCopyCandidates(
  settings: LaunchSettings,
  agents: readonly TuiAgent[] | undefined
): ManagedCopyCandidate[] {
  try {
    return MANAGED_AGENT_CLI_IDS.flatMap((agent) => {
      if (
        !isTuiAgent(agent) ||
        (agents && !agents.includes(agent)) ||
        // A Command setting runs the user's program, so Orca's copy is never looked up.
        settings.agentCmdOverrides?.[agent]?.trim() ||
        standInSpec(agent)?.managedCopyAllowed?.(settings) === false
      ) {
        return []
      }
      const path = installedManagedAgentLauncher(agent)
      const [program] = getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], process.platform).split(
        ' '
      )
      return path && managedAgentStandsInFor(agent, program) ? [{ agent, path, program }] : []
    })
  } catch (error) {
    console.warn('[managed-runtime] Orca-installed agents left out of launches:', error)
    return []
  }
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

function managedCommandsWithoutOwn(
  candidates: readonly ManagedCopyCandidate[],
  own: readonly string[]
): ManagedAgentCommands {
  const commands: ManagedAgentCommands = {}
  candidates.forEach(({ agent, path, program }, index) => {
    // A program found on PATH or in its installer's folder is the user's, unless it is Orca's.
    if (own[index] === program || isManagedAgentCopyPath(agent, own[index])) {
      commands[agent] = path
    }
  })
  return commands
}

/** Full paths to Orca's copies this host launches for `agents` (all when absent): installed,
 *  allowed to run, standing in for a CLI the user doesn't have, with no Command setting. Hosts
 *  without such a copy look nothing up. */
export async function readHostManagedAgentCommands(
  settings: LaunchSettings,
  agents?: readonly TuiAgent[]
): Promise<ManagedAgentCommands> {
  const candidates = managedCopyCandidates(settings, agents)
  if (candidates.length === 0) {
    return {}
  }
  const own = await Promise.all(candidates.map(({ program }) => lookUpOwnProgram(program)))
  return managedCommandsWithoutOwn(candidates, own)
}
