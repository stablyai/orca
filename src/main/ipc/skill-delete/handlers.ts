import { app } from 'electron'
import type { Store } from '../../persistence'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import {
  SkillDeleteRequestSchema,
  type SkillDeletePlan,
  type SkillDeleteResult
} from '../../../shared/skill-delete-contract'
import { SkillDiscoveryTargetSchema } from '../../../shared/skills'
import {
  previewSkillDeleteRequest,
  runSkillDeleteRequest,
  type SkillDeleteRequestDependencies
} from '../../skills/skill-delete/request-service'
import { resolveSkillDiscoveryTarget } from '../../skills/skill-discovery-target'
import { handleMainWindowSkillIpc } from '../skill-ipc-main-window'

/**
 * Local only. A remote runtime is reached straight from the renderer through
 * `callRuntimeRpc`, mirroring how the scan is routed — there is deliberately no
 * main-process remote branch here, unlike install and remove, because a
 * main-side capability check on one transport never runs on the other.
 */
export function registerSkillDeleteIpcHandlers(store: Store, runtime?: OrcaRuntimeService): void {
  const dependencies: SkillDeleteRequestDependencies = {
    repos: () => store.getRepos(),
    ...(runtime
      ? {
          resolveProviderRootOverrides: (target) =>
            runtime.resolveSkillDiscoveryProviderRoots(target)
        }
      : {}),
    userDataPath: app.getPath('userData')
  }
  const resolve = (value: unknown) => {
    const request = SkillDeleteRequestSchema.parse(value)
    // Send exactly what the scan sent: the nested target keeps discovery's own
    // stripping schema, while the request itself is strict.
    const target = resolveSkillDiscoveryTarget(
      request.target ? SkillDiscoveryTargetSchema.parse(request.target) : undefined
    )
    return { request, target }
  }

  handleMainWindowSkillIpc(
    'skills:previewDelete',
    async (_event, value: unknown): Promise<SkillDeletePlan> => {
      const { request, target } = resolve(value)
      return previewSkillDeleteRequest(request, target, dependencies)
    }
  )

  handleMainWindowSkillIpc(
    'skills:delete',
    async (_event, value: unknown): Promise<SkillDeleteResult> => {
      const { request, target } = resolve(value)
      return runSkillDeleteRequest(request, target, dependencies)
    }
  )
}
