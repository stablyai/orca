import type { z } from 'zod'
import type { SkillDiscoveryTargetSchema } from '../../../../../shared/skills/discovery/skills'
import { resolveSkillDiscoveryTarget } from '../../../../skills/discovery/skill-discovery-target'
import type { OrcaRuntimeService } from '../../../orca-runtime'

// Use the same target resolution for discovery and delete-plan roots, including WSL.
export function resolveDiscoveryTarget(
  params: z.infer<typeof SkillDiscoveryTargetSchema>,
  runtime: Pick<OrcaRuntimeService, 'resolveProjectRuntimeForWorktree'>,
  options: { refuseStoppedWslDistro?: boolean } = {}
) {
  const target = params.projectRuntime
    ? params
    : {
        ...params,
        projectRuntime: runtime.resolveProjectRuntimeForWorktree(params.worktreeId)
      }
  return resolveSkillDiscoveryTarget(target, options)
}
