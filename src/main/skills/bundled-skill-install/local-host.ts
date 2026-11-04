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

export type BundledSkillSelection = {
  names?: readonly string[]
  force?: readonly string[] | 'all'
  installedOnly?: boolean
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
