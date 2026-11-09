import {
  SKILL_SHARE_VERSION_CHANGED_CODE,
  type SkillCloudDownloadGrant,
  type SkillCloudInstallTarget,
  type SkillCloudOperation,
  type SkillCloudOptions
} from '../../../shared/skill-cloud-contract'
import { SkillCloudRequestError } from './skill-cloud-request-error'

export function assertSkillCloudGrantVersion(
  grant: SkillCloudDownloadGrant,
  versionId: string
): void {
  if (grant.version.versionId !== versionId) {
    throw new Error('skill-package-version-mismatch')
  }
}

type ShareGrantOptions = SkillCloudOptions & {
  versionId: string
  installTarget?: SkillCloudInstallTarget
}

/** The link moved past the reviewed version, so the user reviews the new one instead of installing it. */
export async function createReviewedShareGrant(
  runtime: {
    createSkillDownloadGrant(
      shareId: string,
      options: ShareGrantOptions
    ): Promise<SkillCloudOperation<SkillCloudDownloadGrant>>
  },
  shareId: string,
  options: ShareGrantOptions
): Promise<SkillCloudOperation<SkillCloudDownloadGrant> | { status: 'version-changed' }> {
  try {
    return await runtime.createSkillDownloadGrant(shareId, options)
  } catch (error) {
    if (
      error instanceof SkillCloudRequestError &&
      error.code === SKILL_SHARE_VERSION_CHANGED_CODE
    ) {
      return { status: 'version-changed' }
    }
    throw error
  }
}
