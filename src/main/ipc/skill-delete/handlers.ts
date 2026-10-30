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

/** Local IPC only: remote scan/delete use renderer runtime RPC, so their capability checks stay on that transport. */
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
  const resolve = async (value: unknown) => {
    const request = SkillDeleteRequestSchema.parse(value)
    // Preserve discovery's nested stripping schema inside the strict deletion request.
    const target = await resolveSkillDiscoveryTarget(
      request.target ? SkillDiscoveryTargetSchema.parse(request.target) : undefined
    )
    return { request, target }
  }

  handleMainWindowSkillIpc(
    'skills:previewDelete',
    async (_event, value: unknown): Promise<SkillDeletePlan> => {
      const { request, target } = await resolve(value)
      return previewSkillDeleteRequest(request, target, dependencies)
    }
  )

  handleMainWindowSkillIpc(
    'skills:delete',
    async (_event, value: unknown): Promise<SkillDeleteResult> => {
      const { request, target } = await resolve(value)
      return runSkillDeleteRequest(request, target, dependencies)
    }
  )
}
