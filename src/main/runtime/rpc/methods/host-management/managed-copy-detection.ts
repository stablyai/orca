// Which of Orca's copies of agent CLIs are installed, for agent detection.

import {
  installedManagedAgentCommand,
  MANAGED_AGENT_CLI_IDS,
  managedAgentCli,
  launchReleasesPending,
  noteLaunchReleasesRecorded,
  type ManagedAgentCliId
} from '../../../../managed-agent-cli/managed-agent-cli-registry'
import { runtimeReleaseMayBePublished } from '../../../../node-runtime/managed-runtime-release'
import { getProfileUserDataPath } from '../../../../orca-profiles/profile-storage-paths'
import { provideInstalledManagedAgents } from '../../../../preflight/managed-agent-detection'
import { notifyAgentsRefreshedOnHost } from '../../../../preflight/agents-refreshed-on-host'

// What the disk check counted before launch reclaim read the releases, so that read can say when
// it disagrees.
const countedOnDisk = new Set<ManagedAgentCliId>()

function rememberedManagedAgents(): ManagedAgentCliId[] {
  return MANAGED_AGENT_CLI_IDS.filter((agent) => installedManagedAgentCommand(agent) !== null)
}

/** An installed copy is an installed agent to menus and Settings. Until launch reclaim has read
 *  Orca's releases, detection looks for them itself, so no reader waits for that read. */
export function provideManagedAgentDetection(): void {
  provideInstalledManagedAgents(async () => {
    try {
      // Once launch reclaim has read every release, installs and removals keep them current.
      if (launchReleasesPending() === null) {
        return rememberedManagedAgents()
      }
      const dataDirectory = getProfileUserDataPath()
      const present = await Promise.all(
        MANAGED_AGENT_CLI_IDS.map((agent) =>
          runtimeReleaseMayBePublished(managedAgentCli(agent).runtime.root(dataDirectory))
        )
      )
      // Reclaim may have completed while the disk check was in flight; never report rejected copies.
      if (launchReleasesPending() === null) {
        return rememberedManagedAgents()
      }
      const found = MANAGED_AGENT_CLI_IDS.filter((_, index) => present[index])
      for (const agent of found) {
        countedOnDisk.add(agent)
      }
      return found
    } catch (error) {
      console.warn('[managed-runtime] Orca-installed agents left out of detection:', error)
      return []
    }
  })
}

/** Launch reclaim has read Orca's releases: detection answers from them from now on, and a copy the
 *  disk check counted that the read found unusable (damaged, another platform's) is announced. */
export function noteManagedReleasesRead(): void {
  noteLaunchReleasesRecorded()
  const counted = [...countedOnDisk]
  countedOnDisk.clear()
  if (counted.length === 0) {
    return
  }
  const remembered = rememberedManagedAgents()
  if (counted.some((agent) => !remembered.includes(agent))) {
    notifyAgentsRefreshedOnHost()
  }
}
