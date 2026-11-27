import { waitForPromiseWithSignal } from '../../../shared/concurrency/abort-signal-reason'
import {
  isSkillInstallProviderId,
  type SkillInstallProviderId
} from '../../../shared/skills/installation/skill-install-providers'
import { detectInstalledAgentsWithShellPathHydration } from '../../preflight/installed-agent-detection'
import { readInstalledManagedAgents } from '../../preflight/managed-agent-detection'

export async function detectLocalSkillInstallProviders(
  signal?: AbortSignal
): Promise<SkillInstallProviderId[]> {
  const terminal = await detectInstalledAgentsWithShellPathHydration(undefined, undefined, signal)
  const managed = await waitForPromiseWithSignal(readInstalledManagedAgents(), signal)
  return [...new Set([...terminal, ...managed])].filter(isSkillInstallProviderId)
}
