import type {
  BundledSkillInstallResult,
  BundledSkillExecuteRequest,
  BundledSkillPlan,
  BundledSkillPlanRequest
} from '../../shared/bundled-skill-plan'
import {
  localBundledSkillInput,
  type BundledSkillSelection
} from '../skills/bundled-skill-install/local-host'
import {
  installBundledSkills,
  previewBundledSkillInstall,
  type BundledSkillServiceInput
} from '../skills/bundled-skill-install/service'
import { clearSkillDiscoveryCaches } from '../skills/skill-discovery-target'
import { resolveSkillInstallDestination } from '../skills/skill-install-destinations'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-contract'
import { createSkillInstallAuthority } from './runtime-skill-install-authority'

/** Named skills are an install for the host's agents; otherwise update what is installed. */
function bundledSkillSelection(request: BundledSkillPlanRequest): BundledSkillSelection {
  return {
    ...(request.names ? { names: request.names } : { installedOnly: true }),
    ...(request.force ? { force: request.force } : {})
  }
}

// Install globally for the user's agents; Update skills without names never adds uninstalled skills. Remote hosts plan via their own RPC.
async function appInput(
  host: RuntimeSkillCommandHost,
  request: BundledSkillPlanRequest
): Promise<BundledSkillServiceInput> {
  const destination = await resolveSkillInstallDestination(
    { scope: 'global' },
    createSkillInstallAuthority(host)
  )
  // Recovery may still hold these paths for a cloud transaction.
  await host.skillTransactionRecovery
  return localBundledSkillInput({
    userDataPath: host.getUserDataPath(),
    destination,
    claudeConfigDirectory: host.getClaudeConfigDirectory?.({ runtime: 'host' }),
    selection: bundledSkillSelection(request)
  })
}

export async function planLocalBundledSkills(
  host: RuntimeSkillCommandHost,
  request: BundledSkillPlanRequest
): Promise<BundledSkillPlan> {
  return previewBundledSkillInstall(await appInput(host, request))
}

export async function executeLocalBundledSkills(
  host: RuntimeSkillCommandHost,
  { planDigest, request }: BundledSkillExecuteRequest
): Promise<BundledSkillInstallResult> {
  const result = await installBundledSkills(await appInput(host, request), planDigest)
  // Discovery would otherwise serve its pre-install answer from cache.
  clearSkillDiscoveryCaches()
  return result
}
