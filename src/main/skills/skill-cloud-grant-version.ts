import type { SkillCloudDownloadGrant } from '../../shared/skill-cloud-contract'

export function assertSkillCloudGrantVersion(
  grant: SkillCloudDownloadGrant,
  versionId: string
): void {
  if (grant.version.versionId !== versionId) {
    throw new Error('skill-package-version-mismatch')
  }
}
