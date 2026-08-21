import type { SkillInstallDestination } from '../../shared/skill-install-contract'
import type { MCodeRuntimeService } from '../runtime/mcode-runtime'

export async function classifySkillCloudInstallTarget(
  runtime: MCodeRuntimeService,
  input: { environmentId?: string; destination: SkillInstallDestination }
): Promise<'local' | 'remote'> {
  return input.environmentId || (await runtime.skillInstallDestinationUsesSsh(input.destination))
    ? 'remote'
    : 'local'
}
