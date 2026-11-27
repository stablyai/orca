import { join } from 'node:path'
import { throwIfSignalAborted } from '../../../shared/concurrency/abort-signal-reason'
import {
  isSkillInstallProviderId,
  type SkillInstallProviderId
} from '../../../shared/skills/installation/skill-install-providers'
import { enableCliInventoryDirectoryReads } from '../../ipc/command-path/command-path-directory-worker-client'
import { killActiveShellProbes } from '../../startup/shell-environment/shell-probe-lifetime'
import {
  readUserClaudeConfigDir,
  resolveClaudeDefaultHome
} from '../../claude-accounts/profiles/claude-profile-paths'
import {
  resolveEnvironmentSkillProviderRoots,
  withClaudeSkillProviderRoot
} from '../providers/skill-provider-runtime-roots'
import { detectLocalSkillInstallProviders } from '../providers/skill-provider-presence'
import type { BundledSkillServiceInput } from './bundled-skill-installation'
import type { BundledSkillTargetRequest } from './bundled-skill-targets'

export {
  AgentInventoryDeadlineError,
  INVENTORY_COMPLETION_WAIT_MS
} from '../../preflight/agent-command-detection'

export type BundledSkillSelection = {
  names?: readonly string[]
  force?: readonly string[] | 'all'
  installedOnly?: boolean
}

export async function sendCliSkillAgentInventory(userDataPath: string): Promise<void> {
  const stop = (): void => {
    try {
      killActiveShellProbes()
    } finally {
      // Node can hang joining native filesystem work.
      process.kill(process.pid, 'SIGKILL')
    }
  }
  process.once('disconnect', stop)
  if (!process.connected) {
    stop()
    return
  }
  enableCliInventoryDirectoryReads()
  let reply: SkillInstallProviderId[] | string
  try {
    const { readManagedAgentsFromDisk } =
      await import('../../managed-agent-cli/managed-agent-cli-registry.js')
    reply = await detectLocalSkillInstallProviders(undefined, () =>
      readManagedAgentsFromDisk(userDataPath, isSkillInstallProviderId)
    )
  } catch (error) {
    reply = error instanceof Error ? error.message : String(error)
  }
  killActiveShellProbes()
  process.send?.(reply, () => {})
}

/** App and CLI share host/agent/provider-root resolution so previews cannot disagree. */
export async function localBundledSkillInput(options: {
  userDataPath: string
  destination: BundledSkillTargetRequest['destination']
  /** `--agent`; detected on this host when omitted. */
  agents?: readonly SkillInstallProviderId[]
  /** Use the app account router when supplied; otherwise ignore CLAUDE_CONFIG_DIR injected by Orca managed-account terminals. */
  claudeConfigDirectory?: string | null
  selection: BundledSkillSelection
  signal?: AbortSignal
}): Promise<BundledSkillServiceInput> {
  const { destination, selection, signal } = options
  throwIfSignalAborted(signal)
  const agents = options.agents ?? (await detectLocalSkillInstallProviders(signal))
  return {
    destination,
    agents,
    providerRootOverrides:
      destination.scope === 'global'
        ? withClaudeSkillProviderRoot(
            resolveEnvironmentSkillProviderRoots(process.env, destination.homeDirectory),
            options.claudeConfigDirectory ??
              resolveClaudeDefaultHome(
                destination.homeDirectory,
                readUserClaudeConfigDir(process.env)
              )
          )
        : {},
    stateDirectory: join(options.userDataPath, 'skill-installs'),
    ...(selection.names ? { names: selection.names } : {}),
    ...(selection.force ? { force: selection.force } : {}),
    ...(selection.installedOnly ? { installedOnly: true } : {})
  }
}
