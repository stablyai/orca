import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../shared/skills'
import type {
  SkillCloudOperation,
  SkillCloudOwnedShare,
  SkillCloudPackageDetails
} from '../../shared/skill-cloud-contract'
import type {
  ManagedSkillInstallListOperation,
  SkillBundleInstallPreviewInput,
  SkillBundleInstallPreviewOperation,
  SkillBundlePackageVersionInstallInput,
  SkillBundleShareInstallInput,
  SkillBundleShareInstallOperation,
  SkillInstallCancelInput,
  SkillInstallPreviewInput,
  SkillInstallPreviewOperation,
  SkillInstallProgress,
  SkillPackageVersionInstallInput,
  SkillRemoveInput,
  SkillRemoveOperation,
  SkillShareInstallInput,
  SkillShareInstallOperation,
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

export type SkillsApi = {
  discover: (target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>
  freshnessInventory: () => Promise<SkillFreshnessInventory>
  startUpdateRun: (names: string[]) => Promise<SkillUpdateStartResult>
  cancelUpdateRun: () => Promise<void>
  acknowledgeUpdateRun: () => Promise<void>
  getUpdateRun: () => Promise<SkillUpdateRun>
  prepareShare: (input: {
    skillIds: string[]
    bundleName: string
    target?: SkillDiscoveryTarget
    packageId?: string
  }) => Promise<SkillSharePreview>
  publishShare: (input: SkillSharePublishInput) => Promise<SkillSharePublishOperation>
  cancelShare: (preparationId: string) => Promise<void>
  releaseShare: (preparationId: string) => Promise<void>
  resolveShare: (shareId: string) => Promise<SkillShareResolvedOperation>
  installShare: (input: SkillShareInstallInput) => Promise<SkillShareInstallOperation>
  installBundleShare: (
    input: SkillBundleShareInstallInput
  ) => Promise<SkillBundleShareInstallOperation>
  installBundlePackageVersion: (
    input: SkillBundlePackageVersionInstallInput
  ) => Promise<SkillBundleShareInstallOperation>
  installPackageVersion: (
    input: SkillPackageVersionInstallInput
  ) => Promise<SkillShareInstallOperation>
  cancelInstall: (input: SkillInstallCancelInput) => Promise<{ cancelled: boolean }>
  previewInstall: (input: SkillInstallPreviewInput) => Promise<SkillInstallPreviewOperation>
  previewBundleInstall: (
    input: SkillBundleInstallPreviewInput
  ) => Promise<SkillBundleInstallPreviewOperation>
  removeInstall: (input: SkillRemoveInput) => Promise<SkillRemoveOperation>
  listManagedInstalls: (environmentId?: string) => Promise<ManagedSkillInstallListOperation>
  getPackage: (packageId: string) => Promise<SkillCloudOperation<SkillCloudPackageDetails>>
  listOwnedShares: () => Promise<SkillCloudOperation<SkillCloudOwnedShare[]>>
  revokeShare: (shareId: string) => Promise<SkillCloudOperation<void>>
  deletePackageVersion: (input: {
    packageId: string
    versionId: string
  }) => Promise<SkillCloudOperation<void>>
  deletePackage: (packageId: string) => Promise<SkillCloudOperation<void>>
  listWslDistros: (environmentId?: string) => Promise<string[]>
  onInstallProgress: (callback: (progress: SkillInstallProgress) => void) => () => void
  onShareProgress: (callback: (progress: SkillShareProgress) => void) => () => void
  onUpdateRun: (callback: (run: SkillUpdateRun) => void) => () => void
}
