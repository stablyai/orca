import { ipcRenderer } from 'electron'
import type {
  SkillDeletePlan,
  SkillDeleteRequest,
  SkillDeleteResult
} from '../../shared/skill-delete-contract'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../shared/skills'
import type {
  SkillCloudOwnedShare,
  SkillCloudOperation,
  SkillCloudPackageDetails
} from '../../shared/skill-cloud-contract'
import type {
  SkillBundleInstallPreviewInput,
  SkillBundleInstallPreviewOperation,
  SkillBundlePackageVersionInstallInput,
  SkillBundleShareInstallInput,
  SkillBundleShareInstallOperation,
  SkillInstallPreviewInput,
  SkillInstallPreviewOperation,
  ManagedSkillInstallListOperation,
  SkillPackageVersionInstallInput,
  SkillRemoveInput,
  SkillRemoveOperation,
  SkillShareInstallInput,
  SkillShareInstallOperation,
  SkillInstallCancelInput,
  SkillInstallProgress,
  SkillSharePreview,
  SkillShareProgress,
  SkillSharePublishInput,
  SkillSharePublishOperation,
  SkillShareResolvedOperation
} from '../../shared/skill-sharing-contract'
import type {
  SkillFreshnessInventory,
  SkillUpdateRun,
  SkillUpdateStartResult
} from '../../shared/skill-freshness'
import type { PreloadApi } from '../api-types'

export const skillsApi = {
  discover: (target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> =>
    ipcRenderer.invoke('skills:discover', target),
  freshnessInventory: (): Promise<SkillFreshnessInventory> =>
    ipcRenderer.invoke('skills:freshnessInventory'),
  startUpdateRun: (names: string[]): Promise<SkillUpdateStartResult> =>
    ipcRenderer.invoke('skills:startUpdateRun', names),
  cancelUpdateRun: (): Promise<void> => ipcRenderer.invoke('skills:cancelUpdateRun'),
  acknowledgeUpdateRun: (): Promise<void> => ipcRenderer.invoke('skills:acknowledgeUpdateRun'),
  getUpdateRun: (): Promise<SkillUpdateRun> => ipcRenderer.invoke('skills:getUpdateRun'),
  prepareShare: (input: {
    skillIds: string[]
    bundleName: string
    target?: SkillDiscoveryTarget
    packageId?: string
  }): Promise<SkillSharePreview> => ipcRenderer.invoke('skills:prepareShare', input),
  publishShare: (input: SkillSharePublishInput): Promise<SkillSharePublishOperation> =>
    ipcRenderer.invoke('skills:publishShare', input),
  cancelShare: (preparationId: string): Promise<void> =>
    ipcRenderer.invoke('skills:cancelShare', preparationId),
  releaseShare: (preparationId: string): Promise<void> =>
    ipcRenderer.invoke('skills:releaseShare', preparationId),
  resolveShare: (shareId: string): Promise<SkillShareResolvedOperation> =>
    ipcRenderer.invoke('skills:resolveShare', shareId),
  installShare: (input: SkillShareInstallInput): Promise<SkillShareInstallOperation> =>
    ipcRenderer.invoke('skills:installShare', input),
  installBundleShare: (
    input: SkillBundleShareInstallInput
  ): Promise<SkillBundleShareInstallOperation> =>
    ipcRenderer.invoke('skills:installBundleShare', input),
  installBundlePackageVersion: (
    input: SkillBundlePackageVersionInstallInput
  ): Promise<SkillBundleShareInstallOperation> =>
    ipcRenderer.invoke('skills:installBundlePackageVersion', input),
  installPackageVersion: (
    input: SkillPackageVersionInstallInput
  ): Promise<SkillShareInstallOperation> =>
    ipcRenderer.invoke('skills:installPackageVersion', input),
  cancelInstall: (input: SkillInstallCancelInput): Promise<{ cancelled: boolean }> =>
    ipcRenderer.invoke('skills:cancelInstall', input),
  previewInstall: (input: SkillInstallPreviewInput): Promise<SkillInstallPreviewOperation> =>
    ipcRenderer.invoke('skills:previewInstall', input),
  previewBundleInstall: (
    input: SkillBundleInstallPreviewInput
  ): Promise<SkillBundleInstallPreviewOperation> =>
    ipcRenderer.invoke('skills:previewBundleInstall', input),
  removeInstall: (input: SkillRemoveInput): Promise<SkillRemoveOperation> =>
    ipcRenderer.invoke('skills:removeInstall', input),
  // Desktop always registers the delete IPC handlers in its own main process.
  deleteSupported: (): Promise<boolean> => Promise.resolve(true),
  previewDelete: (request: SkillDeleteRequest): Promise<SkillDeletePlan> =>
    ipcRenderer.invoke('skills:previewDelete', request),
  delete: (request: SkillDeleteRequest): Promise<SkillDeleteResult> =>
    ipcRenderer.invoke('skills:delete', request),
  listManagedInstalls: (environmentId?: string): Promise<ManagedSkillInstallListOperation> =>
    ipcRenderer.invoke('skills:listManagedInstalls', environmentId),
  getPackage: (packageId: string): Promise<SkillCloudOperation<SkillCloudPackageDetails>> =>
    ipcRenderer.invoke('skills:getPackage', packageId),
  listOwnedShares: (): Promise<SkillCloudOperation<SkillCloudOwnedShare[]>> =>
    ipcRenderer.invoke('skills:listOwnedShares'),
  revokeShare: (shareId: string): Promise<SkillCloudOperation<void>> =>
    ipcRenderer.invoke('skills:revokeShare', shareId),
  deletePackageVersion: (input: {
    packageId: string
    versionId: string
  }): Promise<SkillCloudOperation<void>> =>
    ipcRenderer.invoke('skills:deletePackageVersion', input),
  deletePackage: (packageId: string): Promise<SkillCloudOperation<void>> =>
    ipcRenderer.invoke('skills:deletePackage', packageId),
  listWslDistros: (environmentId?: string): Promise<string[]> =>
    ipcRenderer.invoke('skills:listWslDistros', environmentId),
  onInstallProgress: (callback: (progress: SkillInstallProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SkillInstallProgress): void =>
      callback(progress)
    ipcRenderer.on('skills:installProgress', listener)
    return () => ipcRenderer.removeListener('skills:installProgress', listener)
  },
  onShareProgress: (callback: (progress: SkillShareProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SkillShareProgress): void =>
      callback(progress)
    ipcRenderer.on('skills:shareProgress', listener)
    return () => ipcRenderer.removeListener('skills:shareProgress', listener)
  },
  onUpdateRun: (callback: (run: SkillUpdateRun) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, run: SkillUpdateRun): void => callback(run)
    ipcRenderer.on('skills:updateRun', listener)
    return () => ipcRenderer.removeListener('skills:updateRun', listener)
  }
} satisfies PreloadApi['skills']
