import type { SkillInstallDestination } from '../../shared/skill-install-contract'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export async function classifySkillCloudInstallTarget(
  runtime: OrcaRuntimeService,
  input: { environmentId?: string; destination: SkillInstallDestination }
): Promise<'local' | 'remote'> {
  return input.environmentId || (await runtime.skillInstallDestinationUsesSsh(input.destination))
    ? 'remote'
    : 'local'
}
