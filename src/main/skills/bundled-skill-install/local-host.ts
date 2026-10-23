import { join } from 'node:path'
import {
  isSkillInstallProviderId,
  type SkillInstallProviderId
} from '../../../shared/skill-install-providers'
import { detectInstalledAgentsWithShellPathHydration } from '../../preflight/installed-agent-detection'
import {
  readUserClaudeConfigDir,
  resolveClaudeDefaultHome
} from '../../claude-accounts/claude-profile-paths'
import {
  resolveEnvironmentSkillProviderRoots,
  withClaudeSkillProviderRoot
} from '../skill-provider-runtime-roots'
import type { BundledSkillServiceInput } from './service'
import type { BundledSkillTargetRequest } from './targets'

/** What the caller chose; everything else about the host is resolved here. */
export type BundledSkillSelection = {
  names?: readonly string[]
  force?: readonly string[] | 'all'
  installedOnly?: boolean
}

/**
 * The one input builder for this machine, shared by the app and `orca skills`, so both plan
 * the same targets: detected agents, provider-root overrides and the cloud-install state dir.
 */
export async function localBundledSkillInput(options: {
  userDataPath: string
  destination: BundledSkillTargetRequest['destination']
  /** `--agent`; detected on this host when omitted. */
  agents?: readonly SkillInstallProviderId[]
  /**
   * The app passes its account router's answer; otherwise the same rule reads this process's
   * env, ignoring a CLAUDE_CONFIG_DIR Orca injected into a managed-account terminal.
   */
  claudeConfigDirectory?: string | null
  selection: BundledSkillSelection
}): Promise<BundledSkillServiceInput> {
  const { destination, selection } = options
  const agents =
    options.agents ??
    (await detectInstalledAgentsWithShellPathHydration()).filter(isSkillInstallProviderId)
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
