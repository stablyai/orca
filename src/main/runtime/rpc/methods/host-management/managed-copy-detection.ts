// Whether Orca's copies of agent CLIs may run here, and which are installed, for agent detection.

import { acpLaunchSpecFor } from '../../../../acp/launch/acp-launch-registry'
import type { ManagedCopySettings } from '../../../../acp/launch/acp-launch-contract'
import {
  installedManagedAgentCommand,
  installedManagedAgentLauncher,
  isManagedAgentCli,
  launchReleasesPending,
  MANAGED_AGENT_CLI_IDS,
  managedAgentStandsInFor,
  noteLaunchReleasesRecorded,
  readManagedAgentsFromDisk,
  type ManagedAgentCliId
} from '../../../../managed-agent-cli/managed-agent-cli-registry'
import { getProfileUserDataPath } from '../../../../orca-profiles/profile-storage-paths'
import { provideInstalledManagedAgents } from '../../../../preflight/managed-agent-detection'
import { notifyAgentsRefreshedOnHost } from '../../../../preflight/agents-refreshed-on-host'
import { resolveExecutableCommandAsync } from '../../../../../shared/shell/command-resolution/node-cli-command-async-resolution'
import { readLocalTerminalAgentProgram } from '../../../../preflight/agent-command-detection'
import { withTimeout } from '../../../../../shared/concurrency/promise-timeout-fallback'
import type { AgentStartupShell } from '../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
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
      countedOnDisk = await readManagedAgentsFromDisk(getProfileUserDataPath(), (agent) =>
        managedCopyMayRun(agent, runtime)
      )
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

type LaunchSettings = ManagedCopySettings

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

export async function resolveNativeChatSignInProgram(
  agent: TuiAgent,
  program: string,
  settings: LaunchSettings,
  shell: AgentStartupShell
): Promise<string | null> {
  const result = await readLocalTerminalAgentProgram(program, shell)
  return 'path' in result
    ? result.path
    : withTimeout(managedCopyFor(agent, program, settings), RELEASE_READ_WAIT_MS, null)
}
