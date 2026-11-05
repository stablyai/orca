import { dirname } from 'node:path'
import { isSkillInstallProviderId } from '../../shared/skill-install-providers'
import type { SkillInstallReceiptV1 } from './skill-install-provenance'

export function historicalSuccessfulProviderRoots(receipt: SkillInstallReceiptV1 | null): string[] {
  return (
    receipt?.placements.flatMap((placement) =>
      isSkillInstallProviderId(placement.provider) &&
      placement.topology !== 'canonical-copy' &&
      placement.status !== 'failed' &&
      placement.status !== 'skipped'
        ? [dirname(placement.path)]
        : []
    ) ?? []
  )
}
