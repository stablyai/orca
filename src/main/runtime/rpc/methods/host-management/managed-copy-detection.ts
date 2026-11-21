// Whether Orca's copies of agent CLIs may run here, and which are installed, for agent detection.

import { acpLaunchSpecFor } from '../../../../acp/launch/acp-launch-registry'
import type { ManagedCopySettings } from '../../../../acp/launch/acp-launch-contract'
import {
  installedManagedAgentCommand,
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

function managedAgentCommandIfInstalled(agent: string): string | null {
  return isManagedAgentCli(agent) ? installedManagedAgentCommand(agent) : null
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
  }, managedAgentCommandIfInstalled)
}

/** Launch reclaim has read Orca's releases: detection answers from them from now on, and lists read
 *  from the disk check before it are announced stale. */
export function noteManagedReleasesRead(): void {
  releasesRead = true
  const counted = countedOnDisk
  countedOnDisk = []
  if (counted.length === 0 || !detectionSettings) {
    return
  }
  // Lists read before this carry no paths for those copies, so launches need them read again.
  notifyAgentsRefreshedOnHost()
}

type ManagedCopyCandidate = { agent: ManagedAgentCliId & TuiAgent; path: string; program: string }

function managedCopyCandidates(settings: ManagedCopySettings): ManagedCopyCandidate[] {
  try {
    return MANAGED_AGENT_CLI_IDS.flatMap((agent) => {
      const path = isTuiAgent(agent) ? installedManagedAgentCommand(agent) : null
      if (
        !path ||
        !isTuiAgent(agent) ||
        standInSpec(agent)?.managedCopyAllowed?.(settings) === false
      ) {
        return []
      }
      const [program] = getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], process.platform).split(
        ' '
      )
      return managedAgentStandsInFor(agent, program) ? [{ agent, path, program }] : []
    })
  } catch (error) {
    console.warn('[managed-runtime] Orca-installed agents left out of launches:', error)
    return []
  }
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

/** Full paths to Orca's copies this host launches: installed, allowed to run, and standing in for a
 *  CLI the user doesn't have. Hosts without Orca's copies look nothing up. */
export async function readHostManagedAgentCommands(
  settings: ManagedCopySettings
): Promise<ManagedAgentCommands> {
  const candidates = managedCopyCandidates(settings)
  if (candidates.length === 0) {
    return {}
  }
  const own = await Promise.all(
    candidates.map(({ program }) => resolveCliCommandAsync(program).catch(() => program))
  )
  return managedCommandsWithoutOwn(candidates, own)
}
