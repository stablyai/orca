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
  BundledSkillExecuteRequest,
  BundledSkillInstallResult,
  BundledSkillPlan,
  BundledSkillPlanRequest
} from '../../shared/bundled-skill-plan'

import type {
  SkillDeletePlan,
  SkillDeleteRequest,
  SkillDeleteResult
} from '../../shared/skill-delete-contract'

export type SkillsApi = {
  discover: (target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>
  /** This machine's plan for Orca's installed skills; paired hosts plan over RPC. */
  bundledPlan: (request?: BundledSkillPlanRequest) => Promise<BundledSkillPlan>
  bundledExecute: (request: BundledSkillExecuteRequest) => Promise<BundledSkillInstallResult>
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
  /** Whether the host answering `previewDelete`/`delete` supports them. Always
   *  true on desktop; on web the "local" host is a remote server that updates
   *  independently and may predate the capability. */
  deleteSupported: () => Promise<boolean>
  previewDelete: (request: SkillDeleteRequest) => Promise<SkillDeletePlan>
  delete: (request: SkillDeleteRequest) => Promise<SkillDeleteResult>
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
}
