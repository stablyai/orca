import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { withSkillIpcRegistrar } from './skill-ipc-main-window'

const SKILLS_IPC_CHANNELS = [
  'skills:discover',
  'skills:bundledPlan',
  'skills:bundledExecute',
  'skills:bundledAutoUpdate',
  'skills:prepareShare',
  'skills:publishShare',
  'skills:cancelShare',
  'skills:releaseShare',
  'skills:resolveShare',
  'skills:installShare',
  'skills:installBundleShare',
  'skills:installPackageVersion',
  'skills:installBundlePackageVersion',
  'skills:cancelInstall',
  'skills:getPackage',
  'skills:listOwnedShares',
  'skills:revokeShare',
  'skills:deletePackage',
  'skills:listWslDistros',
  'skills:previewInstall',
  'skills:previewBundleInstall',
  'skills:removeInstall',
  'skills:listManagedInstalls'
] as const

const SKILL_DELETE_IPC_CHANNELS = ['skills:previewDelete', 'skills:delete'] as const

export function registerLazySkillsHandlers(store: Store, runtime?: OrcaRuntimeService): void {
  const channels = runtime ? SKILLS_IPC_CHANNELS : (['skills:discover'] as const)
  registerLazyIpcHandleGroup(channels, async (ipc) => {
    const { registerSkillsHandlers } = await import('./skills')
    withSkillIpcRegistrar(ipc, () => registerSkillsHandlers(store, runtime))
  })
}

export function registerLazySkillDeleteIpcHandlers(
  store: Store,
  runtime?: OrcaRuntimeService
): void {
  registerLazyIpcHandleGroup(SKILL_DELETE_IPC_CHANNELS, async (ipc) => {
    const { registerSkillDeleteIpcHandlers } = await import('../skill-delete/handlers')
    withSkillIpcRegistrar(ipc, () => registerSkillDeleteIpcHandlers(store, runtime))
  })
}
